import pino, { type Logger } from 'pino';
import type { Config } from './config';

export function createLogger(cfg: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>, name = 'app'): Logger {
  return pino({
    name,
    level: cfg.LOG_LEVEL,
    transport:
      cfg.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
        : undefined,
  });
}
