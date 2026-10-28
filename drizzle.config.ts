import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/database/src/schema.ts',
  out: './packages/database/src/migrations',
});
