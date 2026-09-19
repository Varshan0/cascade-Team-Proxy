import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Config } from '../shared/config';
import type { Db } from '../shared/db/client';
import type { Redis } from '../shared/redis';
import { ApiError } from './errors';
import { healthRoutes } from './routes/health';
import { liquidationRoutes } from './routes/liquidations';
import { marketRoutes } from './routes/market';
import { signalRoutes } from './routes/signals';
import { registerGateway } from './ws';

/** Where the built web UI lives (`npm run web:build`); overridable with WEB_DIST. */
// In the merged repository the Vite frontend lives at the repository root.
const DEFAULT_WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist');
/** Paths that belong to the backend: an unknown one is a JSON 404, never the web app's index.html. */
const BACKEND_PATH = /^\/(api|health|docs|ws)(\/|\?|$)/;

export interface AppContext {
  config: Config;
  db: Db;
  redis: Redis;
  logger: Logger;
}

export type App = FastifyInstance;

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export async function buildApp(ctx: AppContext): Promise<App> {
  const app = Fastify({
    loggerInstance: ctx.logger,
    // Every log line carries the request id (as `reqId`), and it is echoed back to the client.
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('ctx', ctx);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(cors, { origin: ctx.config.CORS_ORIGINS, credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      info: { title: 'Trading terminal API', version: '0.1.0' },
      servers: [{ url: '/' }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((raw, req, reply) => {
    const err = raw as Error & { statusCode?: number };
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Request validation failed', details: err.validation },
      });
    }
    if (err instanceof ApiError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.status(status).send({
      error: {
        code: status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'bad_request',
        message: status >= 500 ? 'Internal server error' : err.message,
      },
    });
  });

  // Serve the built web UI (if present) from the same origin, with an SPA fallback for client-side routes such as
  // /terminal/ETH-USD. Only browser navigations (Accept: text/html) outside the backend's own paths get index.html.
  const webDist = ctx.config.WEB_DIST ?? DEFAULT_WEB_DIST;
  const serveWeb = existsSync(join(webDist, 'index.html'));
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false, // register the actual files; everything else falls through to the not-found handler below
      setHeaders: (res, path) => {
        // hashed bundles are immutable; index.html must always revalidate. `path` uses backslashes on Windows.
        res.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    if (serveWeb && wantsHtml && !BACKEND_PATH.test(req.url)) return reply.type('text/html').sendFile('index.html');
    return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  await app.register(healthRoutes);
  await app.register(marketRoutes);
  await app.register(liquidationRoutes);
  await app.register(signalRoutes);
  registerGateway(app as unknown as App);
  // The Zod-typed instance is structurally the same server; widen it so callers see one `App` type.
  return app as unknown as App;
}
