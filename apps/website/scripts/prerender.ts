/**
 * Turns the client build (`dist/`) and the SSR build (`.tmp/ssr/`) into static pages:
 * one `index.html` per route and locale, `404.html` per locale, `sitemap.xml` and `robots.txt`.
 * Run by `pnpm --filter @hepson/website build`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(appDir, 'dist');
const ssrDir = join(appDir, '.tmp', 'ssr');

const server = (await import(pathToFileURL(join(ssrDir, 'entry-server.js')).href)) as typeof import('../src/entry-server');
const template = readFileSync(join(dist, 'index.html'), 'utf8');

// JSON in a <script> must not be able to close the tag.
const safeJson = (s: string) => s.replace(/</g, '\\u003c');

for (const { file, locale, route } of server.targets()) {
  const page = server.render(locale, route);
  const html = template
    .replace('<html lang="uk">', `<html lang="${locale}">`)
    .replace('<!--head-->', page.head)
    .replace('<!--app-->', page.html)
    .replace('</body>', `  <script id="page-ctx" type="application/json">${safeJson(page.ctx)}</script>\n  </body>`);
  const out = join(dist, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}

writeFileSync(join(dist, 'sitemap.xml'), server.sitemap());
writeFileSync(join(dist, 'robots.txt'), server.robots());
rmSync(ssrDir, { recursive: true, force: true });
console.log(`prerendered ${server.targets().length} pages into ${dist}`);
