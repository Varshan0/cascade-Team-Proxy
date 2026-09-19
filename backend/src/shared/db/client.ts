import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

/** Driver-agnostic handle: postgres-js in prod, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

export function createDb(url: string): DbHandle {
  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema }) as unknown as Db, close: () => sql.end() };
}

export { schema };
