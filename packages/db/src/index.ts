import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export { schema };
export * from './schema.js';

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: DB;
  driver: 'postgres' | 'pglite';
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultMigrationsFolder = process.env.MIGRATIONS_DIR ?? path.resolve(here, '../migrations');

/**
 * DATABASE_URL forms:
 *   postgres://user:pass@host:5432/db   – PostgreSQL (production / hosted)
 *   pglite:///absolute/path/to/dir     – embedded Postgres (desktop local mode)
 *   pglite:memory                       – in-memory (tests)
 */
export async function openDatabase(url: string): Promise<DatabaseHandle> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX ?? 10) });
    const db = drizzle(pool, { schema }) as unknown as DB;
    return { db, driver: 'postgres', close: () => pool.end() };
  }
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const target = url.slice('pglite:'.length).replace(/^\/\//, '');
    const client = target === 'memory' || target === '' ? new PGlite() : new PGlite(target);
    await client.waitReady;
    const db = drizzle(client, { schema }) as unknown as DB;
    return { db, driver: 'pglite', close: () => client.close() };
  }
  throw new Error('Unsupported DATABASE_URL. Use postgres://… or pglite:…');
}

export async function migrateDatabase(handle: DatabaseHandle, migrationsFolder = defaultMigrationsFolder): Promise<void> {
  if (handle.driver === 'postgres') {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(handle.db as never, { migrationsFolder });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db as never, { migrationsFolder });
  }
}
