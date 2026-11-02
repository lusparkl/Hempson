import { renderToString } from 'react-dom/server';
import { App } from './App';
import { headTags } from './head';
import { ROUTES, type RouteId } from './routes';
import { SITE } from './site';

export type RenderedPage = { route: RouteId; html: string; head: string; ctx: string };

/** Renders one page to HTML. `ctx` is the JSON the client hydrates from, so it never re-derives the route. */
export function render(route: RouteId): RenderedPage {
  return {
    route,
    html: renderToString(<App route={route} />),
    head: headTags(route),
    ctx: JSON.stringify({ route }),
  };
}

/** Every file the prerender step writes, relative to `dist/`. */
export function targets(): Array<{ file: string; route: RouteId }> {
  return [...ROUTES.map((r) => ({ file: `${r.path.slice(1)}index.html`, route: r.id })), { file: '404.html', route: 'notFound' }];
}

export function sitemap(): string {
  const urls = ROUTES.map((r) => `  <url><loc>${SITE.url}${r.path}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function robots(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`;
}
