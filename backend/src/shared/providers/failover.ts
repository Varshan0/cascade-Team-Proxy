import { FAILOVER_CHAINS, type ChainName } from '../config';

export interface ChainStep<T> {
  /** Must equal a name listed in FAILOVER_CHAINS[chain]. */
  name: string;
  run: () => Promise<T>;
}

export class ChainExhaustedError extends Error {
  constructor(
    readonly chain: string,
    readonly failures: Array<{ provider: string; error: string }>,
  ) {
    super(`all providers failed for ${chain}: ${failures.map((f) => `${f.provider}: ${f.error}`).join('; ') || 'none available'}`);
  }
}

/**
 * Try the available steps in the order the config gives. Steps whose provider is disabled or unconfigured
 * are simply absent from `steps`; order and membership come from FAILOVER_CHAINS, not from the caller.
 */
export async function runChain<T>(chain: ChainName, steps: ChainStep<T>[]): Promise<{ value: T; source: string }> {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const failures: Array<{ provider: string; error: string }> = [];
  for (const name of FAILOVER_CHAINS[chain]) {
    const step = byName.get(name);
    if (!step) continue;
    try {
      return { value: await step.run(), source: name };
    } catch (err) {
      failures.push({ provider: name, error: (err as Error).message });
    }
  }
  throw new ChainExhaustedError(chain, failures);
}
