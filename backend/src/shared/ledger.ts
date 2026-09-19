import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { accounts, ledgerEntries } from './db/schema';

/**
 * Double-entry paper ledger. Every movement writes rows sharing a tx_id, and for each asset the rows of a
 * tx sum to zero (the counterparty is the `system` account). Balances are derived, never stored.
 */
type Executor = Pick<Db, 'insert' | 'select'>;

export async function ensureAccount(db: Db, kind: 'user' | 'bot' | 'system', name: string, userId?: string): Promise<string> {
  const [found] = await db.select().from(accounts).where(and(eq(accounts.kind, kind), eq(accounts.name, name)));
  if (found) return found.id;
  const [row] = await db.insert(accounts).values({ kind, name, userId: userId ?? null }).returning({ id: accounts.id });
  return row!.id;
}

const entry = (txId: string, accountId: string, asset: string, amount: Decimal, kind: string, refId?: string) => ({
  txId,
  accountId,
  asset,
  amount: amount.toFixed(),
  kind,
  refId: refId ?? null,
});

const newTxId = () => crypto.randomUUID();

export async function deposit(db: Db, accountId: string, systemId: string, usdAmount: Decimal, refId?: string): Promise<void> {
  const tx = newTxId();
  await db.insert(ledgerEntries).values([entry(tx, accountId, 'USD', usdAmount, 'deposit', refId), entry(tx, systemId, 'USD', usdAmount.neg(), 'deposit', refId)]);
}

export interface TradeInput {
  accountId: string;
  systemId: string;
  base: string; // ETH
  side: 'buy' | 'sell';
  qty: Decimal;
  price: Decimal;
  fee: Decimal; // USD, always >= 0
  refId?: string;
}

/** One atomic trade: asset leg + cash leg + fee leg, each balanced against the system account. */
export async function recordTrade(db: Db, t: TradeInput): Promise<void> {
  const tx = newTxId();
  const cash = t.qty.times(t.price);
  const dir = t.side === 'buy' ? 1 : -1;
  await db.insert(ledgerEntries).values([
    entry(tx, t.accountId, t.base, t.qty.times(dir), 'trade', t.refId),
    entry(tx, t.systemId, t.base, t.qty.times(-dir), 'trade', t.refId),
    entry(tx, t.accountId, 'USD', cash.times(-dir), 'trade', t.refId),
    entry(tx, t.systemId, 'USD', cash.times(dir), 'trade', t.refId),
    entry(tx, t.accountId, 'USD', t.fee.neg(), 'fee', t.refId),
    entry(tx, t.systemId, 'USD', t.fee, 'fee', t.refId),
  ]);
}

export async function balances(db: Executor, accountId: string): Promise<Record<string, Decimal>> {
  const rows = await db
    .select({ asset: ledgerEntries.asset, total: sql<string>`sum(${ledgerEntries.amount})::text` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
    .groupBy(ledgerEntries.asset);
  return Object.fromEntries(rows.map((r) => [r.asset, new Decimal(r.total)]));
}

/** Consistency check: returns every (tx, asset) whose entries do not sum to zero. Empty means healthy. */
export async function ledgerViolations(db: Executor): Promise<Array<{ txId: string; asset: string; sum: string }>> {
  const rows = await db
    .select({ txId: ledgerEntries.txId, asset: ledgerEntries.asset, total: sql<string>`sum(${ledgerEntries.amount})::text` })
    .from(ledgerEntries)
    .groupBy(ledgerEntries.txId, ledgerEntries.asset);
  return rows.filter((r) => !new Decimal(r.total).isZero()).map((r) => ({ txId: r.txId, asset: r.asset, sum: r.total }));
}
