import { migrateDatabase, openDatabase } from '@secretary/db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const h = await openDatabase(url);
await migrateDatabase(h);
await h.close();
console.log('Migrations applied.');
