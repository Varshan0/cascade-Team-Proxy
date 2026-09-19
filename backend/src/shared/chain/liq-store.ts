import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { assets, liquidations } from '../db/schema';
import { trimDecimal } from '../market/store';

export const etherscanTx = (hash: string) => `https://etherscan.io/tx/${hash}`;

export interface LiquidationDTO {
  id: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  ts: string;
  collateralAsset: string;
  collateralSymbol: string | null;
  debtAsset: string;
  debtSymbol: string | null;
  user: string;
  liquidator: string;
  debtAmountRaw: string;
  collateralAmountRaw: string;
  usdValue: string | null;
  status: string;
  txUrl: string;
}

type Row = typeof liquidations.$inferSelect;

export async function assetSymbols(db: Db): Promise<Map<string, string>> {
  const rows = await db.select({ address: assets.address, symbol: assets.symbol }).from(assets);
  return new Map(rows.map((r) => [r.address.toLowerCase(), r.symbol]));
}

export function toDTO(r: Row, symbols: Map<string, string>): LiquidationDTO {
  return {
    id: r.id,
    txHash: r.txHash,
    logIndex: r.logIndex,
    blockNumber: r.blockNumber,
    ts: r.ts.toISOString(),
    collateralAsset: r.collateralAsset,
    collateralSymbol: symbols.get(r.collateralAsset.toLowerCase()) ?? null,
    debtAsset: r.debtAsset,
    debtSymbol: symbols.get(r.debtAsset.toLowerCase()) ?? null,
    user: r.user,
    liquidator: r.liquidator,
    debtAmountRaw: r.debtAmountRaw,
    collateralAmountRaw: r.collateralAmountRaw,
    usdValue: r.usdValue === null ? null : trimDecimal(r.usdValue),
    status: r.status,
    txUrl: etherscanTx(r.txHash),
  };
}

export interface ListParams {
  from?: Date;
  to?: Date;
  asset?: string;
  minUsd?: string;
  limit: number;
  cursor?: string;
}

const encodeCursor = (ts: Date, id: number) => Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
export function decodeCursor(c: string): { ts: string; id: number } | null {
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
    return ts && id && !Number.isNaN(Date.parse(ts)) && Number.isInteger(Number(id)) ? { ts, id: Number(id) } : null;
  } catch {
    return null;
  }
}

/** Newest first, keyset-paginated on (ts, id). */
export async function listLiquidations(db: Db, p: ListParams): Promise<{ items: LiquidationDTO[]; nextCursor: string | null }> {
  const cur = p.cursor ? decodeCursor(p.cursor) : null;
  const where = and(
    p.from ? gte(liquidations.ts, p.from) : undefined,
    p.to ? lte(liquidations.ts, p.to) : undefined,
    p.asset ? eq(liquidations.collateralAsset, p.asset.toLowerCase()) : undefined,
    p.minUsd ? sql`${liquidations.usdValue} >= ${p.minUsd}` : undefined,
    cur ? sql`(${liquidations.ts}, ${liquidations.id}) < (${cur.ts}::timestamptz, ${cur.id})` : undefined,
  );
  const rows = await db.select().from(liquidations).where(where).orderBy(desc(liquidations.ts), desc(liquidations.id)).limit(p.limit + 1);
  const page = rows.slice(0, p.limit);
  const symbols = await assetSymbols(db);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toDTO(r, symbols)),
    nextCursor: rows.length > p.limit && last ? encodeCursor(last.ts, last.id) : null,
  };
}

export async function recentLiquidations(db: Db, n: number): Promise<LiquidationDTO[]> {
  return (await listLiquidations(db, { limit: n })).items;
}

export interface LiquidationStats {
  window: string;
  totalUsd: string;
  count: number;
  topAssets: Array<{ asset: string; symbol: string | null; usd: string; count: number }>;
  hourly: Array<{ hour: string; usd: string; count: number }>;
}

export async function liquidationStats(db: Db, windowMs: number, windowLabel: string, now = Date.now()): Promise<LiquidationStats> {
  const from = new Date(now - windowMs);
  const inWindow = gte(liquidations.ts, from);
  const [tot] = await db
    .select({ usd: sql<string>`coalesce(sum(${liquidations.usdValue}), 0)::text`, n: sql<number>`count(*)::int` })
    .from(liquidations)
    .where(inWindow);
  const top = await db
    .select({ asset: liquidations.collateralAsset, usd: sql<string>`coalesce(sum(${liquidations.usdValue}), 0)::text`, n: sql<number>`count(*)::int` })
    .from(liquidations)
    .where(inWindow)
    .groupBy(liquidations.collateralAsset)
    .orderBy(sql`coalesce(sum(${liquidations.usdValue}), 0) desc`)
    .limit(5);
  const hourExpr = sql<string>`(extract(epoch from date_trunc('hour', ${liquidations.ts})) * 1000)::bigint::text`;
  const hourly = await db
    .select({ h: hourExpr, usd: sql<string>`coalesce(sum(${liquidations.usdValue}), 0)::text`, n: sql<number>`count(*)::int` })
    .from(liquidations)
    .where(inWindow)
    .groupBy(hourExpr)
    .orderBy(hourExpr);
  const symbols = await assetSymbols(db);
  return {
    window: windowLabel,
    totalUsd: trimDecimal(tot?.usd ?? '0'),
    count: tot?.n ?? 0,
    topAssets: top.map((t) => ({ asset: t.asset, symbol: symbols.get(t.asset.toLowerCase()) ?? null, usd: trimDecimal(t.usd), count: t.n })),
    hourly: hourly.map((h) => ({ hour: new Date(Number(h.h)).toISOString(), usd: trimDecimal(h.usd), count: h.n })),
  };
}
