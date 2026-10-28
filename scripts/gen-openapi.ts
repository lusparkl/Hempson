import { writeFileSync } from 'node:fs';
import { buildApp } from '../apps/api/src/server';
import { buildOpenApi } from '../apps/api/src/openapi';
import { registry } from '../apps/api/src/routes/define';

const a = await buildApp({ dbFile: ':memory:', logger: false });
writeFileSync('docs/openapi.json', JSON.stringify(buildOpenApi(registry), null, 2) + '\n');
await a.close();
console.log('wrote docs/openapi.json');
