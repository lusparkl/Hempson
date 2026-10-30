import { CredentialVault, Keyring, openDb, runMigrations } from '@hepson/database';
import { loadConfig } from '../apps/api/src/config';

// Master-key rotation (D28). Set HEPSON_MASTER_KEY + HEPSON_MASTER_KEY_VERSION to the NEW key and
// HEPSON_MASTER_KEY_PREVIOUS + HEPSON_MASTER_KEY_PREVIOUS_VERSION to the old one, then run `pnpm rewrap-credentials`.
// Secrets are not decrypted or changed, only their data keys are re-wrapped. Safe to run twice. Stop the API first or take a `pnpm backup`.
const ring = Keyring.fromEnv(process.env);
if (!ring) {
  console.error('HEPSON_MASTER_KEY is not set');
  process.exit(1);
}
const h = openDb(loadConfig().dbFile);
runMigrations(h);
try {
  const r = new CredentialVault(h, ring).rewrapAll();
  console.log(`credentials: ${r.total} total, ${r.rewrapped} re-wrapped to master key version ${ring.currentVersion}`);
} catch (e) {
  console.error(`rewrap failed, nothing changed: ${e instanceof Error ? e.message : 'error'}`);
  process.exitCode = 1;
} finally {
  h.close();
}
