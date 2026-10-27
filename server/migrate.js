import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadEnv } from './config.js';
const { Pool } = pg;
export async function runMigrations() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run PostgreSQL migrations.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = path.resolve('migrations');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      const already = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (already.rowCount) continue;
      const sql = await readFile(path.join(directory, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query(sql); await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]); await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      process.stdout.write('Applied ' + file + '\n');
    }
  } finally { await pool.end(); }
}
if (process.argv[1]?.endsWith('migrate.js')) loadEnv().then(runMigrations).catch((error) => { console.error(error.message); process.exitCode = 1; });
