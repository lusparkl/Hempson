import { AuthRepository, openDb, runMigrations } from '@hepson/database';
import { RESET_TTL_MS, resetLink } from '../apps/api/src/auth/reset';
import { loadConfig } from '../apps/api/src/config';

// usage: pnpm reset-link <email>
const email = process.argv[2];
if (!email) {
  console.error('usage: pnpm reset-link <email>');
  process.exit(1);
}
const cfg = loadConfig();
const h = openDb(cfg.dbFile);
runMigrations(h);
const auth = new AuthRepository(h);
const user = auth.getUserByEmail(email);
if (user) {
  const link = resetLink(cfg.dashboardUrl, auth.createPasswordReset(user.id, RESET_TTL_MS));
  console.log(`One-time password reset link, valid for 1 hour. Anyone holding it can take over this account:\n\n${link}\n`);
} else {
  console.error('No user with that email');
  process.exitCode = 1;
}
h.close();
