import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers';

const HTML = { accept: 'text/html,application/xhtml+xml' };
let dist: string;
let t: TestContext;
let bare: TestContext;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'web-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>cascade</title><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  t = await createTestContext({ WEB_DIST: dist });
  bare = await createTestContext({ WEB_DIST: join(dist, 'does-not-exist') });
}, 60_000); // two in-process Postgres instances
afterAll(async () => {
  await t.close();
  await bare.close();
});

describe('serving the built web UI from Fastify', () => {
  it('serves index.html at / and revalidates it', async () => {
    const r = await t.app.inject({ url: '/', headers: HTML });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<div id="root">');
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets as immutable', async () => {
    const r = await t.app.inject({ url: '/assets/app-abc123.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('immutable');
  });

  it('falls back to index.html for client-side routes on browser navigations only', async () => {
    const page = await t.app.inject({ url: '/terminal/ETH-USD', headers: HTML });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="root">');
    // an API-style request for the same path is a JSON 404, not HTML
    const api = await t.app.inject({ url: '/terminal/ETH-USD', headers: { accept: 'application/json' } });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('not_found');
  });

  it('never shadows the backend: unknown /api, /health, /docs and /ws paths stay JSON 404 even for browsers', async () => {
    for (const url of ['/api/v1/nope', '/api/nope', '/health/nope', '/docs/nope', '/ws/nope']) {
      const r = await t.app.inject({ url, headers: HTML });
      expect(r.statusCode, url).toBe(404);
      expect(r.headers['content-type'], url).toContain('application/json');
      expect(r.json().error.code, url).toBe('not_found');
    }
  });

  it('leaves every real backend route working', async () => {
    expect((await t.app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await t.app.inject({ url: '/api/v1/instruments', headers: HTML })).json().instruments).toBeDefined();
    expect((await t.app.inject({ url: '/docs/json' })).statusCode).toBe(200);
  });

  it('runs API-only (JSON 404 at /) when there is no build', async () => {
    const r = await bare.app.inject({ url: '/', headers: HTML });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
    expect((await bare.app.inject({ url: '/health' })).statusCode).toBe(200);
  });
});
