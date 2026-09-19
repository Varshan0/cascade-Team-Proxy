export const INTERVALS = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
} as const;

export type Interval = keyof typeof INTERVALS;
export const INTERVAL_LIST = Object.keys(INTERVALS) as Interval[];

/** Buckets are epoch-aligned, which is 00:00 UTC alignment for every interval up to 1d. */
export const bucketStart = (t: number, i: Interval): number => Math.floor(t / INTERVALS[i]) * INTERVALS[i];

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function isInterval(s: string): s is Interval {
  return s in INTERVALS;
}
