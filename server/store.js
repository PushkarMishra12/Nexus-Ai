import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createSeedState } from './seed.js';
const { Pool } = pg;
class FileStore {
  constructor(filePath) { this.filePath = path.resolve(filePath); this.queue = Promise.resolve(); }
  async initialize() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try { await readFile(this.filePath, 'utf8'); }
    catch { await this.atomicWrite(await createSeedState()); }
  }
  async read() { await this.queue; return JSON.parse(await readFile(this.filePath, 'utf8')); }
  async atomicWrite(state) {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8'); await rename(temp, this.filePath);
  }
  async mutate(fn) {
    let result;
    const pending = this.queue.then(async () => {
      const state = JSON.parse(await readFile(this.filePath, 'utf8'));
      result = await fn(state); await this.atomicWrite(state);
    });
    this.queue = pending.then(() => undefined, () => undefined); await pending; return result;
  }
  async close() {}
}
class PgStore {
  constructor(connectionString) { this.pool = new Pool({ connectionString, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined }); }
  async initialize() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS system_state (id smallint PRIMARY KEY CHECK (id = 1), state_json jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await this.pool.query('SELECT state_json FROM system_state WHERE id = 1');
    if (!rows.length) await this.pool.query('INSERT INTO system_state(id, state_json) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(await createSeedState())]);
  }
  async read() { const { rows } = await this.pool.query('SELECT state_json FROM system_state WHERE id = 1'); return rows[0]?.state_json ?? await createSeedState(); }
  async mutate(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT state_json FROM system_state WHERE id = 1 FOR UPDATE');
      const state = rows[0]?.state_json ?? await createSeedState();
      const result = await fn(state);
      await client.query('INSERT INTO system_state(id, state_json, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = now()', [JSON.stringify(state)]);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
export async function createStore() {
  const store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new FileStore(process.env.DATA_FILE || './data/nexusai.json');
  await store.initialize(); return store;
}
