import Decimal from 'decimal.js';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { readSnapshot } from '../../shared/bus';
import { accounts, indexerState, ledgerEntries, signalEvents } from '../../shared/db/schema';
import { balances } from '../../shared/ledger';
import { modeOf } from '../../shared/runtime';
import { drillStatus, isDrillActive, runDrill } from '../../shared/strategy/drill';
import { errors } from '../errors';

const modeSchema = z.enum(['live', 'replay', 'drill', 'offline']);

export const signalRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, redis, config, logger } = app.ctx;
  const live = modeOf(config);

  app.get(
    '/api/v1/signals/state',
    {
      schema: {
        tags: ['signals'],
        summary: 'Current Cascade Catcher state, meters and reason (the drill\'s synthetic state while a drill runs)',
        response: {
          200: z.object({
            asOf: z.string(), mode: modeSchema, source: z.string(), synthetic: z.boolean(), drillActive: z.boolean(),
            state: z.record(z.string(), z.unknown()),
          }),
        },
      },
    },
    async () => {
      const drill = await isDrillActive(redis);
      const snap = (drill ? await readSnapshot(redis, 'signal', true) : null) ?? (await readSnapshot(redis, 'signal'));
      if (!snap?.data) throw errors.unavailable('The signal engine has not produced a state yet');
      return {
        asOf: new Date().toISOString(),
        mode: snap.synthetic ? ('drill' as const) : live,
        source: 'cascade-engine',
        synthetic: !!snap.synthetic,
        drillActive: drill,
        state: snap.data as Record<string, unknown>,
      };
    },
  );

  app.get(
    '/api/v1/signals/history',
    {
      schema: {
        tags: ['signals'],
        summary: 'State transitions (live engine only; drills are never recorded)',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.coerce.number().int().optional() }),
        response: {
          200: z.object({
            asOf: z.string(), mode: modeSchema, source: z.string(),
            items: z.array(z.object({ id: z.number(), ts: z.string(), state: z.string(), mode: z.string(), payload: z.unknown() })),
            nextCursor: z.number().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await db.select().from(signalEvents).where(cursor ? lt(signalEvents.id, cursor) : undefined).orderBy(desc(signalEvents.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        asOf: new Date().toISOString(),
        mode: live,
        source: 'cascade-engine',
        items: page.map((r) => ({ id: r.id, ts: r.ts.toISOString(), state: r.state, mode: r.mode, payload: r.payload })),
        nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
      };
    },
  );

  app.get(
    '/api/v1/signals/bot',
    {
      schema: {
        tags: ['signals'],
        summary: "The strategy bot's own paper account: balances, open position and trade history (never a user's account)",
        response: {
          200: z.object({
            asOf: z.string(), mode: modeSchema, source: z.string(),
            account: z.object({ id: z.string(), name: z.string(), kind: z.string() }),
            balances: z.record(z.string(), z.string()),
            engine: z.object({ equity: z.number(), position: z.record(z.string(), z.unknown()).nullable(), pausedUntil: z.number().nullable(), lastExitT: z.number().nullable() }),
            trades: z.array(z.object({ txId: z.string(), ts: z.string(), side: z.enum(['buy', 'sell']), asset: z.string(), qty: z.string(), price: z.string(), fee: z.string(), ref: z.string().nullable() })),
          }),
        },
      },
    },
    async () => {
      const [acct] = await db.select().from(accounts).where(and(eq(accounts.kind, 'bot'), eq(accounts.name, 'cascade-bot')));
      if (!acct) throw errors.unavailable('The signal engine has not created the bot account yet');
      const bal = await balances(db, acct.id);
      const [row] = await db.select().from(indexerState).where(eq(indexerState.key, 'signal-engine:ETH-USD'));
      const st = (row?.meta as { state?: { equity: number; position: Record<string, unknown> | null; pausedUntil: number | null; lastExitT: number | null } } | null)?.state;
      const entries = await db
        .select()
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.accountId, acct.id), inArray(ledgerEntries.kind, ['trade', 'fee'])))
        .orderBy(asc(ledgerEntries.id));
      const byTx = new Map<string, typeof entries>();
      for (const e of entries) byTx.set(e.txId, [...(byTx.get(e.txId) ?? []), e]);
      const trades = [...byTx.entries()].flatMap(([txId, es]) => {
        const leg = es.find((e) => e.kind === 'trade' && e.asset !== 'USD');
        const cash = es.find((e) => e.kind === 'trade' && e.asset === 'USD');
        const fee = es.find((e) => e.kind === 'fee');
        if (!leg || !cash) return [];
        const qty = new Decimal(leg.amount);
        return [{ txId, ts: leg.ts.toISOString(), side: qty.gt(0) ? ('buy' as const) : ('sell' as const), asset: leg.asset, qty: qty.abs().toFixed(), price: new Decimal(cash.amount).abs().div(qty.abs()).toDecimalPlaces(6).toFixed(), fee: new Decimal(fee?.amount ?? 0).abs().toFixed(), ref: leg.refId }];
      });
      return {
        asOf: new Date().toISOString(),
        mode: live,
        source: 'cascade-engine',
        account: { id: acct.id, name: acct.name, kind: acct.kind },
        balances: Object.fromEntries(Object.entries(bal).map(([k, v]) => [k, v.toFixed()])),
        engine: { equity: st?.equity ?? 10_000, position: st?.position ?? null, pausedUntil: st?.pausedUntil ?? null, lastExitT: st?.lastExitT ?? null },
        trades,
      };
    },
  );

  app.get(
    '/api/v1/demo/status',
    { schema: { tags: ['demo'], summary: 'Which data mode is active', response: { 200: z.object({ mode: modeSchema, offline: z.boolean(), drillActive: z.boolean() }) } } },
    async () => ({ mode: live, offline: config.DEMO_OFFLINE, drillActive: await isDrillActive(redis) }),
  );

  app.post(
    '/api/v1/demo/drill',
    {
      schema: {
        tags: ['demo'],
        summary: 'Inject a synthetic 6.5% crash + ~$40M liquidation burst + rebound into an isolated copy of state',
        description: 'Every message is tagged `synthetic: true` and `mode: "drill"`. Real data, accounts and ledgers are never touched. Returns immediately; poll GET /demo/drill.',
        body: z.object({ speed: z.number().min(0.5).max(1000).default(1) }).default({ speed: 1 }),
        response: { 202: z.object({ status: z.literal('started'), speed: z.number() }) },
      },
    },
    async (req, reply) => {
      if (await isDrillActive(redis)) throw errors.conflict('A drill is already running');
      void runDrill({ redis, config, logger }, { speed: req.body.speed }).catch((err) => logger.error({ err }, 'drill failed'));
      return reply.status(202).send({ status: 'started' as const, speed: req.body.speed });
    },
  );

  app.get(
    '/api/v1/demo/drill',
    { schema: { tags: ['demo'], summary: 'Status and result of the latest drill', response: { 200: z.record(z.string(), z.unknown()) } } },
    async () => ({ ...(await drillStatus(redis)) }),
  );
};
