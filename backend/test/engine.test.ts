import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { accounts, candles, indexerState, ledgerEntries, liquidations, signalEvents } from '../src/shared/db/schema';
import { balances, deposit, ensureAccount, ledgerViolations, recordTrade } from '../src/shared/ledger';
import { upsertCandles } from '../src/shared/market/store';
import { BOT_START_EQUITY, COVERAGE_KEY, SignalEngine } from '../src/shared/strategy/engine';
import { createTestContext, type TestContext } from './helpers';

const H = 3_600_000;

describe('ledger', () => {
  let t: TestContext;
  beforeAll(async () => (t = await createTestContext()));
  afterAll(() => t.close());

  it('deposit + buy + sell keep every tx balanced and derive balances from entries', async () => {
    const acct = await ensureAccount(t.db, 'user', 'alice');
    const sys = await ensureAccount(t.db, 'system', 'system');
    expect(await ensureAccount(t.db, 'user', 'alice')).toBe(acct); // idempotent

    await deposit(t.db, acct, sys, new Decimal(10_000));
    await recordTrade(t.db, { accountId: acct, systemId: sys, base: 'ETH', side: 'buy', qty: new Decimal('1.5'), price: new Decimal('2000'), fee: new Decimal('3') });
    let b = await balances(t.db, acct);
    expect(b.ETH!.toFixed()).toBe('1.5');
    expect(b.USD!.toFixed()).toBe('6997'); // 10000 - 3000 - 3 fee

    await recordTrade(t.db, { accountId: acct, systemId: sys, base: 'ETH', side: 'sell', qty: new Decimal('1.5'), price: new Decimal('2100'), fee: new Decimal('3.15') });
    b = await balances(t.db, acct);
    expect(b.ETH!.toFixed()).toBe('0');
    expect(b.USD!.toFixed()).toBe('10143.85'); // 6997 + 3150 - 3.15
    expect(await ledgerViolations(t.db)).toEqual([]);

    // the system account is the exact mirror image: nothing is created or destroyed
    const s = await balances(t.db, sys);
    expect(s.USD!.plus(b.USD!).toFixed()).toBe('0');
  });

  it('detects an unbalanced transaction', async () => {
    const acct = await ensureAccount(t.db, 'user', 'mallory');
    await t.db.insert(ledgerEntries).values({ txId: crypto.randomUUID(), accountId: acct, asset: 'USD', amount: '5', kind: 'deposit' });
    const v = await ledgerViolations(t.db);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ asset: 'USD', sum: '5.000000000000' });
    await t.db.delete(ledgerEntries).where(eq(ledgerEntries.accountId, acct));
  });
});

describe('live signal engine', () => {
  let t: TestContext;
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
  let n = 0;

  const seedMarket = async (price = 2000) => {
    const cs = Array.from({ length: 180 }, (_, i) => ({ t: Math.floor(now / 60_000) * 60_000 - (i + 1) * 60_000, o: String(price), h: String(price), l: String(price), c: String(price), v: '1', source: 'test' }));
    await upsertCandles(t.db, 'ETH-USD', '1m', cs);
  };
  const seedLiqs = async (burst: number, baseline = 100_000) => {
    const rows = Array.from({ length: 170 }, (_, i) => ({ ts: new Date(now - H - i * H - 30 * 60_000), usd: baseline }));
    if (burst > 0) rows.push({ ts: new Date(now - 10 * 60_000), usd: burst });
    await t.db.insert(liquidations).values(
      rows.map((r) => ({
        txHash: '0x' + (++n).toString(16).padStart(64, '0'), logIndex: 0, blockNumber: n, blockHash: '0x' + 'f'.repeat(64), ts: r.ts,
        collateralAsset: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', debtAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        user: '0x' + '1'.repeat(40), liquidator: '0x' + '2'.repeat(40), debtAmountRaw: '1', collateralAmountRaw: '1', usdValue: String(r.usd), status: 'confirmed',
      })),
    );
  };
  const setFast = (price: number, ageMs = 0) =>
    t.redis.set('px:good:ETH-USD', JSON.stringify({ instrument: 'ETH-USD', price: String(price), ts: new Date(now - ageMs).toISOString(), source: 'coinbase-ws', suspect: false }));

  beforeEach(async () => {
    t = await createTestContext();
    await seedMarket();
    await t.redis.set(COVERAGE_KEY, String(now - 400 * H));
  });
  afterEach(async () => t?.close());

  it('fires on a real cascade, paper-trades the BOT account, and keeps equity == ledger cash', async () => {
    await seedLiqs(2_000_000);
    await setFast(1900);
    const engine = new SignalEngine(t.rt);
    const fired = await engine.evaluate(now);
    expect(fired).toMatchObject({ state: 'fired', priceSource: 'fast', symbol: 'ETH-USD' });
    expect(fired!.reason).toMatch(/ENTRY/);

    const bot = engine.botAccountId;
    const [acct] = await t.db.select().from(accounts).where(eq(accounts.id, bot));
    expect(acct).toMatchObject({ kind: 'bot', name: 'cascade-bot', userId: null }); // never a user's account
    const b1 = await balances(t.db, bot);
    expect(b1.ETH!.toNumber()).toBeGreaterThan(1);
    expect(b1.USD!.toNumber()).toBeCloseTo(BOT_START_EQUITY - (BOT_START_EQUITY / 3) * 1.001, 4);

    expect((await engine.evaluate(now + 60_000))!.state).toBe('in_position'); // no second entry
    expect((await balances(t.db, bot)).ETH!.toFixed()).toBe(b1.ETH!.toFixed());

    await setFast(1960); // above the target (~1951)
    const exit = await engine.evaluate(now + 5 * 60_000);
    expect(exit!.state).toBe('watching');
    expect(exit!.reason).toMatch(/exited via target/);
    const b2 = await balances(t.db, bot);
    expect(b2.ETH!.toFixed()).toBe('0');
    expect(b2.USD!.toNumber()).toBeCloseTo(exit!.equity, 6); // engine equity is exactly the ledger's cash
    expect(b2.USD!.toNumber()).toBeGreaterThan(BOT_START_EQUITY);
    expect(await ledgerViolations(t.db)).toEqual([]);
  });

  it('exposes the bot account, balances, engine state and trade history over REST', async () => {
    await seedLiqs(2_000_000);
    await setFast(1900);
    const engine = new SignalEngine(t.rt);
    await engine.evaluate(now);
    await setFast(1960);
    await engine.evaluate(now + 5 * 60_000);
    const r = (await t.app.inject({ url: '/api/v1/signals/bot' })).json();
    expect(r.account).toMatchObject({ name: 'cascade-bot', kind: 'bot' });
    expect(r.trades.map((x: { side: string }) => x.side)).toEqual(['buy', 'sell']);
    expect(r.trades[0]).toMatchObject({ asset: 'ETH' });
    expect(Number(r.trades[0].price)).toBeCloseTo(1900 * 1.0015, 4);
    expect(r.balances.ETH).toBe('0');
    expect(Number(r.balances.USD)).toBeCloseTo(r.engine.equity, 6);
    expect(r.engine.position).toBeNull();
  });

  it('records every state transition (and only transitions) in signal_events', async () => {
    await seedLiqs(2_000_000);
    await setFast(1900);
    const engine = new SignalEngine(t.rt);
    await engine.evaluate(now);
    await engine.evaluate(now + 60_000);
    await engine.evaluate(now + 120_000); // still in_position: no new row
    await setFast(1960);
    await engine.evaluate(now + 5 * 60_000);
    const rows = await t.db.select().from(signalEvents).orderBy(signalEvents.id);
    expect(rows.map((r) => r.state)).toEqual(['fired', 'in_position', 'watching']);
    expect(rows.every((r) => r.mode === 'live')).toBe(true);
  });

  it('resumes an open position after a restart without re-entering or double-booking', async () => {
    await seedLiqs(2_000_000);
    await setFast(1900);
    const e1 = new SignalEngine(t.rt);
    await e1.evaluate(now);
    const before = (await t.db.select().from(ledgerEntries)).length;

    const e2 = new SignalEngine(t.rt); // fresh process, same DB
    const r = await e2.evaluate(now + 60_000);
    expect(r!.state).toBe('in_position');
    expect(r!.position).not.toBeNull();
    expect((await t.db.select().from(ledgerEntries)).length).toBe(before);
    const [saved] = await t.db.select().from(indexerState).where(eq(indexerState.key, 'signal-engine:ETH-USD'));
    expect(saved).toBeDefined();
  });

  it('falls back to the Chainlink price when the fast price is older than 5 minutes', async () => {
    await seedLiqs(0);
    await setFast(1234, 6 * 60_000);
    await t.redis.set('snap:oracle:ETH-USD', JSON.stringify({ data: { chainlinkPrice: '2000.5' } }));
    const r = await new SignalEngine(t.rt).evaluate(now);
    expect(r).toMatchObject({ priceSource: 'chainlink', price: 2000.5 });
  });

  it('returns null (no signal) when neither a fresh fast price nor a Chainlink price exists', async () => {
    await setFast(2000, 30 * 60_000);
    expect(await new SignalEngine(t.rt).evaluate(now)).toBeNull();
  });

  it('stays in warming until liquidation coverage reaches 169h, even during a cascade', async () => {
    await seedLiqs(2_000_000);
    await setFast(1900);
    await t.redis.set(COVERAGE_KEY, String(now - 30 * H)); // e.g. only 30h of liquidation history indexed
    const r = await new SignalEngine(t.rt).evaluate(now);
    expect(r!.state).toBe('warming');
    expect(r!.reason).toMatch(/30h of 169h/);
    const bal = await balances(t.db, (await t.db.select().from(accounts).where(eq(accounts.kind, 'bot')))[0]!.id);
    expect(bal.ETH).toBeUndefined();
  });

  it('never trades on stale/missing coverage info (unknown coverage = warming)', async () => {
    await seedLiqs(2_000_000);
    await setFast(1900);
    await t.redis.del(COVERAGE_KEY);
    expect((await new SignalEngine(t.rt).evaluate(now))!.state).toBe('warming');
  });

  it('publishes each evaluation on the signal channel with a snapshot', async () => {
    await seedLiqs(0);
    await setFast(2000);
    const seen: string[] = [];
    const sub = t.redis.duplicate();
    await sub.subscribe('ch:signal');
    sub.on('message', (_c: string, m: string) => seen.push(m));
    await new SignalEngine(t.rt).evaluate(now);
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.parse(seen[0]!)).toMatchObject({ channel: 'signal', mode: 'live', data: { state: 'watching', thresholds: { dropThresh: 0.04, zThresh: 3, minLiqUsd: 1_000_000 } } });
    expect(JSON.parse((await t.redis.get('snap:signal'))!).type).toBe('snapshot');
    sub.disconnect();
    // candles table untouched by the engine
    expect((await t.db.select().from(candles)).length).toBe(180);
  });
});
