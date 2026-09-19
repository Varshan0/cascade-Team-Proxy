import { startDemo } from './start';

const demo = await startDemo();
demo.rt.logger.info(
  `\n  Demo running (no Docker, no Postgres, no Redis)\n  App:  ${demo.url}   <- open this (web UI)\n  API:  ${demo.url}/api/v1\n  Docs: ${demo.url}/docs\n  WS:   ${demo.url?.replace('http', 'ws')}/ws\n  Mode: ${demo.rt.config.DEMO_OFFLINE ? 'OFFLINE simulator' : 'LIVE (public market data)'}\n`,
);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  demo.rt.logger.info({ signal }, 'shutting down demo');
  await demo.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
