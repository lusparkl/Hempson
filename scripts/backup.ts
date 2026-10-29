import path from 'node:path';
import { backupDb, openDb } from '@hepson/database';
import { loadConfig } from '../apps/api/src/config';

// Usage: pnpm backup [dest-file]. Safe while the API runs. Never copies profiles/ (Instagram logins): back those up deliberately.
const cfg = loadConfig();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.resolve(process.argv[2] ?? path.join(cfg.dataDir, 'backups', `hepson-${stamp}.db`));
const h = openDb(cfg.dbFile);
await backupDb(h, dest);
h.close();
console.log(`backup written: ${dest}`);
