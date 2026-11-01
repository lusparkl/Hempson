import { DEFAULT_LOCALE, LOCALES, OG_LOCALE, localePath, t, type Locale } from './i18n';
import { pathOf, type RouteId } from './routes';
import { SITE } from './site';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `<head>` tags for one page: title, description, canonical, hreflang alternates and Open Graph. */
export function headTags(locale: Locale, route: RouteId): string {
  const meta = t(locale).pages[route].meta;
  const tags = [`<title>${esc(meta.title)}</title>`, `<meta name="description" content="${esc(meta.description)}" />`];
  if (route === 'notFound') {
    tags.push('<meta name="robots" content="noindex" />');
  } else {
    const path = pathOf(route);
    const url = (l: Locale) => SITE.url + localePath(l, path);
    tags.push(`<link rel="canonical" href="${url(locale)}" />`);
    for (const l of LOCALES) tags.push(`<link rel="alternate" hreflang="${l}" href="${url(l)}" />`);
    tags.push(`<link rel="alternate" hreflang="x-default" href="${url(DEFAULT_LOCALE)}" />`);
    tags.push(`<meta property="og:url" content="${url(locale)}" />`);
  }
  tags.push(
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${SITE.name}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:locale" content="${OG_LOCALE[locale]}" />`,
    `<meta property="og:image" content="${SITE.url}${SITE.ogImage}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
  );
  return tags.join('\n    ');
}
