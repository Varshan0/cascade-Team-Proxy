import type { ZodType } from 'zod';
import type { Redis } from '../redis';
import { HealthTracker, type ProviderHealth } from './health';

/** Contract every provider client implements (spec section 4). */
export interface ProviderClient<Req, Res> {
  name: string;
  call(req: Req, opts?: { signal?: AbortSignal }): Promise<Res>;
  health(): ProviderHealth;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class CircuitOpenError extends ProviderError {
  constructor(provider: string) {
    super(`circuit open for ${provider}`, provider, false);
  }
}

/** Token bucket: `take()` resolves when a token is available, so we shape traffic instead of hitting 429. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private capacity: number,
    private refillPerSec: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
  }

  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
    }
  }
}

/** Opens after N consecutive failures; half-opens after `cooldownMs` and lets one probe through. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold = 5,
    private cooldownMs = 30_000,
    private now: () => number = Date.now,
  ) {}

  /** Throws-by-return: false means fail fast. */
  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      this.probing = false;
    }
    if (this.state === 'half-open' && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = 0;
    this.state = 'closed';
    this.probing = false;
  }

  failure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = this.now();
      this.probing = false;
    }
  }
}

export interface ResilientOptions {
  name: string;
  baseUrl: string;
  headers?: Record<string, string>;
  bucket: { capacity: number; refillPerSec: number };
  redis?: Redis;
  timeoutMs?: number;
  maxRetries?: number;
  breaker?: { threshold?: number; cooldownMs?: number };
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected in tests to make backoff instant. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface GetOptions<T> {
  query?: Record<string, string | number | undefined>;
  schema: ZodType<T>;
  /** Redis cache TTL in seconds; omit to skip the cache. */
  ttlSec?: number;
  timeoutMs?: number;
}

const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 5_000;

/** GET-JSON transport with timeouts, jittered retries, breaker, rate limiting, cache and Zod validation. */
export class ResilientHttp {
  readonly tracker: HealthTracker;
  private bucket: TokenBucket;
  private breaker: CircuitBreaker;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;

  constructor(private o: ResilientOptions) {
    this.tracker = new HealthTracker(o.name);
    this.bucket = new TokenBucket(o.bucket.capacity, o.bucket.refillPerSec, o.now);
    this.breaker = new CircuitBreaker(o.breaker?.threshold, o.breaker?.cooldownMs, o.now);
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
  }

  health(): ProviderHealth {
    return this.tracker.snapshot();
  }

  async getJson<T>(path: string, opts: GetOptions<T>): Promise<T> {
    const url = new URL(this.o.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const cacheKey = `pc:${this.o.name}:${url.pathname}${url.search}`;

    if (opts.ttlSec && this.o.redis) {
      const hit = await this.o.redis.get(cacheKey);
      if (hit) {
        const parsed = opts.schema.safeParse(JSON.parse(hit));
        if (parsed.success) return parsed.data;
      }
    }

    if (!this.breaker.allow()) {
      this.tracker.circuit = this.breaker.state;
      throw new CircuitOpenError(this.o.name);
    }
    this.tracker.circuit = this.breaker.state;

    const started = Date.now();
    try {
      const json = await this.fetchWithRetry(url, opts.timeoutMs ?? this.o.timeoutMs ?? 5_000);
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        // A shape change is a provider failure: fail loudly and let the failover chain move on.
        throw new ProviderError(`response validation failed: ${parsed.error.issues[0]?.message ?? 'invalid'}`, this.o.name, false);
      }
      this.breaker.success();
      this.tracker.circuit = this.breaker.state;
      this.tracker.recordSuccess(Date.now() - started);
      if (opts.ttlSec && this.o.redis) await this.o.redis.set(cacheKey, JSON.stringify(json), 'EX', opts.ttlSec);
      return parsed.data;
    } catch (err) {
      this.breaker.failure();
      this.tracker.circuit = this.breaker.state;
      this.tracker.recordError(err, Date.now() - started);
      throw err;
    }
  }

  private async fetchWithRetry(url: URL, timeoutMs: number): Promise<unknown> {
    const maxRetries = this.o.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastErr instanceof ProviderError ? lastErr.retryAfterMs : undefined;
        // Full jitter: uniform in [0, min(cap, base * 2^n)], but never sooner than Retry-After.
        const jitter = this.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        await this.sleep(Math.max(retryAfter ?? 0, jitter));
      }
      await this.bucket.take();
      try {
        const res = await this.fetchImpl(url, {
          headers: { accept: 'application/json', ...this.o.headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const remaining = res.headers.get('x-ratelimit-remaining');
        if (remaining !== null && Number.isFinite(Number(remaining))) this.tracker.quotaRemaining = Number(remaining);
        if (res.ok) return await res.json();
        const retryable = res.status === 429 || res.status >= 500;
        const ra = Number(res.headers.get('retry-after'));
        throw new ProviderError(
          `${this.o.name} HTTP ${res.status}`,
          this.o.name,
          retryable,
          res.status,
          Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
        );
      } catch (err) {
        lastErr = err instanceof ProviderError ? err : new ProviderError(`${this.o.name} network error: ${(err as Error).message}`, this.o.name, true);
        if (!(lastErr as ProviderError).retryable) throw lastErr;
      }
    }
    throw lastErr;
  }
}
