import { ApiKeyRepository, openDb, runMigrations } from '@hepson/database';
import { loadConfig } from '../apps/api/src/config';

// usage: pnpm bootstrap-key [name]
const name = process.argv[2] ?? 'admin';
const h = openDb(loadConfig().dbFile);
await runMigrations(h);
const { key } = await new ApiKeyRepository(h).create(name);
console.log(`Operator API key — shown ONCE, only its SHA-256 hash is stored:\n\n${key}\n`);
h.close();
