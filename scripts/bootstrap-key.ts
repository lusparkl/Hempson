import { openDb, runMigrations, Store } from '@hepson/database';
import { loadConfig } from '../apps/api/src/config';

// usage: pnpm bootstrap-key [name] [--account <uuid>]
const args = process.argv.slice(2);
const ai = args.indexOf('--account');
const accountId = ai >= 0 ? (args[ai + 1] ?? null) : null;
const name = args.find((a, i) => !a.startsWith('--') && i !== ai + 1) ?? (accountId ? 'account-key' : 'admin');
const h = openDb(loadConfig().dbFile);
runMigrations(h);
const store = new Store(h);
if (accountId && !store.getAccount(accountId)) {
  console.error('unknown account id');
  process.exit(1);
}
const { key } = store.createApiKey(name, accountId);
console.log(`API key (${accountId ? `scoped to ${accountId}` : 'ADMIN'}) — shown ONCE, only its SHA-256 hash is stored:\n\n${key}\n`);
h.close();
