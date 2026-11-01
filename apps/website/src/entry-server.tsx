import { renderToString } from 'react-dom/server';
import { App } from './App';
import { headTags } from './head';
import { LOCALES, localePath, type Locale } from './i18n';
import { ROUTES, type RouteId } from './routes';
import { SITE } from './site';

export type RenderedPage = { locale: Locale; route: RouteId; html: string; head: string; ctx: string };

/** Renders one page to HTML. `ctx` is the JSON the client hydrates from, so it never re-derives the route. */
export function render(locale: Locale, route: RouteId): RenderedPage {
  return {
    locale,
    route,
    html: renderToString(<App locale={locale} route={route} />),
    head: headTags(locale, route),
    ctx: JSON.stringify({ locale, route }),
  };
}

/** Every file the prerender step writes, relative to `dist/`. */
export function targets(): Array<{ file: string; locale: Locale; route: RouteId }> {
  const out: Array<{ file: string; locale: Locale; route: RouteId }> = [];
  for (const locale of LOCALES) {
    for (const r of ROUTES) out.push({ file: `${localePath(locale, r.path).slice(1)}index.html`, locale, route: r.id });
    out.push({ file: `${localePath(locale, '/').slice(1)}404.html`, locale, route: 'notFound' });
  }
  return out;
}

export function sitemap(): string {
  const urls = LOCALES.flatMap((l) => ROUTES.map((r) => `  <url><loc>${SITE.url}${localePath(l, r.path)}</loc></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function robots(): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`;
}
