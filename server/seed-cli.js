import { existsSync } from 'node:fs';
import { loadEnv } from './config.js';
import { runMigrations } from './migrate.js';
import { createStore } from './store.js';
await loadEnv();
if (process.env.DATABASE_URL) await runMigrations();
const filePath = process.env.DATA_FILE || './data/nexusai.json';
const alreadyExists = !process.env.DATABASE_URL && existsSync(filePath);
const store = await createStore();
const state = await store.read();
process.stdout.write(alreadyExists
  ? 'Existing workspace data kept. Tasks: ' + state.tasks.length + '; events: ' + state.events.length + '.\n'
  : 'Demo data ready. Sign in as ' + state.users[0].email + ' using the password documented in README.md.\n');
await store.close();
