import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDatabase, openDatabase } from '@secretary/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startWorker } from './services/jobs.js';

const config = loadConfig();
const handle = await openDatabase(config.DATABASE_URL);
// The production bundle ships its migrations next to main.mjs.
const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
await migrateDatabase(handle, process.env.MIGRATIONS_DIR ?? (fs.existsSync(bundled) ? bundled : undefined));
const { app, deps } = await buildApp({ config, db: handle.db });
const stopWorker = config.JOBS_ENABLED ? startWorker(deps) : () => undefined;

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  stopWorker();
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
// Machine-readable readiness line used by the desktop shell when running as a sidecar.
if (config.LOCAL_MODE) console.log(`SECRETARY_READY ${config.PORT}`);
