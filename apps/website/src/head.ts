import { uk } from './i18n';
import { pathOf, type RouteId } from './routes';
import { SITE } from './site';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `<head>` tags for one page: title, description, canonical and Open Graph. */
export function headTags(route: RouteId): string {
  const meta = uk.pages[route].meta;
  const tags = [`<title>${esc(meta.title)}</title>`, `<meta name="description" content="${esc(meta.description)}" />`];
  if (route === 'notFound') {
    tags.push('<meta name="robots" content="noindex" />');
  } else {
    const url = SITE.url + pathOf(route);
    tags.push(`<link rel="canonical" href="${url}" />`);
    tags.push(`<meta property="og:url" content="${url}" />`);
  }
  tags.push(
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${SITE.name}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    '<meta property="og:locale" content="uk_UA" />',
    `<meta property="og:image" content="${SITE.url}${SITE.ogImage}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
  );
  return tags.join('\n    ');
}
