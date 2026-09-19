import { FAILOVER_CHAINS, type ChainName } from '../config';
import type { Redis } from '../redis';

export type ProviderStatus = 'ok' | 'degraded' | 'down' | 'unknown';
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ProviderHealth {
  name: string;
  status: ProviderStatus;
  circuit: CircuitState;
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorMessage: string | null;
  p95LatencyMs: number | null;
  successCount: number;
  errorCount: number;
  quotaRemaining: number | null;
  /** Set by the worker on publish, used to spot stale snapshots. */
  reportedAt?: string;
}

const WINDOW = 20;
const DOWN_AFTER_CONSECUTIVE = 3;

/** Rolling health for one provider; owned by that provider's client. */
export class HealthTracker {
  private outcomes: boolean[] = [];
  private latencies: number[] = [];
  private lastSuccess: Date | null = null;
  private lastError: Date | null = null;
  private lastErrorMessage: string | null = null;
  private successCount = 0;
  private errorCount = 0;
  circuit: CircuitState = 'closed';
  quotaRemaining: number | null = null;

  constructor(readonly name: string) {}

  recordSuccess(latencyMs: number): void {
    this.successCount++;
    this.lastSuccess = new Date();
    this.push(true, latencyMs);
  }

  recordError(err: unknown, latencyMs?: number): void {
    this.errorCount++;
    this.lastError = new Date();
    this.lastErrorMessage = err instanceof Error ? err.message : String(err);
    this.push(false, latencyMs);
  }

  private push(ok: boolean, latencyMs?: number): void {
    this.outcomes.push(ok);
    if (this.outcomes.length > WINDOW) this.outcomes.shift();
    if (latencyMs !== undefined) {
      this.latencies.push(latencyMs);
      if (this.latencies.length > 100) this.latencies.shift();
    }
  }

  snapshot(): ProviderHealth {
    let status: ProviderStatus;
    if (this.circuit === 'open') status = 'down';
    else if (this.outcomes.length === 0) status = 'unknown';
    else {
      const fails = this.outcomes.filter((o) => !o).length;
      let trailing = 0;
      for (let i = this.outcomes.length - 1; i >= 0 && !this.outcomes[i]; i--) trailing++;
      // "down" means it is failing RIGHT NOW (the latest calls all failed). Intermittent failure on a flaky
      // free endpoint is "degraded": it still serves traffic, and must not take the service out of rotation.
      status = fails === 0 ? 'ok' : trailing >= DOWN_AFTER_CONSECUTIVE ? 'down' : 'degraded';
    }
    return {
      name: this.name,
      status,
      circuit: this.circuit,
      lastSuccess: this.lastSuccess?.toISOString() ?? null,
      lastError: this.lastError?.toISOString() ?? null,
      lastErrorMessage: this.lastErrorMessage,
      p95LatencyMs: percentile(this.latencies, 0.95),
      successCount: this.successCount,
      errorCount: this.errorCount,
      quotaRemaining: this.quotaRemaining,
    };
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null;
}

const HASH_KEY = 'health:providers';
const STALE_AFTER_MS = 60_000;

/** Worker-side: publish trackers so the API can serve /health/providers without calling providers. */
export async function publishHealth(redis: Redis, trackers: HealthTracker[]): Promise<void> {
  if (trackers.length === 0) return;
  const reportedAt = new Date().toISOString();
  const entries: string[] = [];
  for (const t of trackers) entries.push(t.name, JSON.stringify({ ...t.snapshot(), reportedAt }));
  await redis.hset(HASH_KEY, ...entries);
}

/** API-side: stale entries (worker down) are reported as `unknown`. */
export async function readHealth(redis: Redis, now = Date.now()): Promise<ProviderHealth[]> {
  const raw = await redis.hgetall(HASH_KEY);
  const out: ProviderHealth[] = [];
  for (const value of Object.values(raw)) {
    try {
      const h = JSON.parse(value) as ProviderHealth;
      const stale = !h.reportedAt || now - Date.parse(h.reportedAt) > STALE_AFTER_MS;
      out.push(stale ? { ...h, status: 'unknown' } : h);
    } catch {
      // ignore corrupt entry; the next publish overwrites it
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type ChainStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** A chain is up if any provider in it is ok; down only when every known provider is down. */
export function evaluateChains(
  providers: ProviderHealth[],
  chains: Record<string, readonly string[]> = FAILOVER_CHAINS,
): Record<string, { status: ChainStatus; providers: string[] }> {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const result: Record<string, { status: ChainStatus; providers: string[] }> = {};
  for (const [chain, names] of Object.entries(chains)) {
    const known = names.map((n) => byName.get(n)).filter((p): p is ProviderHealth => !!p);
    let status: ChainStatus;
    if (known.length === 0) status = 'unknown';
    else if (known.some((p) => p.status === 'ok')) status = 'ok';
    else if (known.every((p) => p.status === 'down')) status = 'down';
    else status = 'degraded';
    result[chain] = { status, providers: [...names] };
  }
  return result;
}

export type { ChainName };
