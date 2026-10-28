import { openDb, runMigrations } from '@hepson/database';
import { loadConfig } from '../apps/api/src/config';

const cfg = loadConfig();
const h = openDb(cfg.dbFile);
runMigrations(h);
h.close();
console.log(`migrations applied: ${cfg.dbFile}`);
