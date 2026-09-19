import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATIC_RESERVES, DEMO_ADDRESS, seedDatabase } from '../src/shared/db/seed';
import { accounts, assets, fills, instruments, orders, positions, users } from '../src/shared/db/schema';
import { balances, ledgerViolations } from '../src/shared/ledger';
import { createTestContext, type TestContext } from './helpers';

let t: TestContext;
beforeAll(async () => (t = await createTestContext()));
afterAll(() => t.close());

describe('db:seed', () => {
  it('seeds instruments, Aave assets, a demo user and a demo paper account with real ledger entries', async () => {
    const s = await seedDatabase(t.db);
    expect(s).toMatchObject({ instruments: 6, demoUser: true, demoTrades: 3 });
    expect((await t.db.select().from(assets)).length).toBe(STATIC_RESERVES.length);
    expect((await t.db.select().from(instruments)).map((i) => i.symbol).sort()).toEqual(['AAVE-USD', 'ARB-USD', 'BTC-USD', 'ETH-USD', 'LINK-USD', 'SOL-USD']);

    const [user] = await t.db.select().from(users).where(eq(users.address, DEMO_ADDRESS));
    expect(user).toBeDefined();
    const [acct] = await t.db.select().from(accounts).where(eq(accounts.userId, user!.id));
    expect(acct).toMatchObject({ kind: 'user', name: 'demo-paper' });

    // 10,000 - 3,900 - 4,050 - 1,325 (sell adds) - fees; ETH 1.5-0.5 = 1, BTC 0.05
    const b = await balances(t.db, acct!.id);
    expect(b.ETH!.toFixed()).toBe('1');
    expect(b.BTC!.toFixed()).toBe('0.05');
    const fees = 3900 * 0.001 + 4050 * 0.001 + 1325 * 0.001;
    expect(b.USD!.toNumber()).toBeCloseTo(10_000 - 3900 - 4050 + 1325 - fees, 6);
    expect(await ledgerViolations(t.db)).toEqual([]);
  });

  it('positions, orders and fills agree with the ledger', async () => {
    const [acct] = await t.db.select().from(accounts).where(eq(accounts.name, 'demo-paper'));
    const pos = await t.db.select().from(positions).where(eq(positions.accountId, acct!.id));
    const eth = pos.find((p) => p.symbol === 'ETH-USD')!;
    expect(Number(eth.qty)).toBe(1);
    expect(Number(eth.avgCost)).toBe(2600);
    expect(Number(eth.realizedPnl)).toBeCloseTo((2650 - 2600) * 0.5 - 1325 * 0.001, 6);
    expect((await t.db.select().from(orders).where(eq(orders.accountId, acct!.id))).every((o) => o.status === 'filled')).toBe(true);
    expect((await t.db.select().from(fills).where(eq(fills.accountId, acct!.id))).length).toBe(3);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = (await t.db.select().from(orders)).length;
    const s = await seedDatabase(t.db);
    expect(s).toMatchObject({ demoUser: false, demoTrades: 0 });
    expect((await t.db.select().from(orders)).length).toBe(before);
    expect((await t.db.select().from(users)).length).toBe(1);
    expect(await ledgerViolations(t.db)).toEqual([]);
  });

  it('uses on-chain reserves when provided and keeps existing assets', async () => {
    const extra = [{ address: '0x' + 'ab'.repeat(20), symbol: 'TEST', decimals: 9 }];
    await seedDatabase(t.db, { reserves: extra });
    const rows = await t.db.select().from(assets);
    expect(rows.some((r) => r.symbol === 'TEST')).toBe(true);
    expect(rows.length).toBe(STATIC_RESERVES.length + 1);
  });
});
