import type { Dict } from './i18n';

/**
 * Every page of the site. Paths are locale-neutral and end with `/` (each is prerendered to
 * `<path>index.html`); the `ru` copy lives under `/ru`. `notFound` has no path: it is written to `404.html`.
 */
export const ROUTES = [
  { id: 'home', path: '/', nav: null },
  { id: 'features', path: '/features/', nav: 'main' },
  { id: 'pricing', path: '/pricing/', nav: 'main' },
  { id: 'about', path: '/about/', nav: 'main' },
  { id: 'security', path: '/security/', nav: 'main' },
  { id: 'contact', path: '/contact/', nav: 'main' },
  { id: 'privacy', path: '/legal/privacy/', nav: 'legal' },
  { id: 'terms', path: '/legal/terms/', nav: 'legal' },
  { id: 'refunds', path: '/legal/refunds/', nav: 'legal' },
  { id: 'cookies', path: '/legal/cookies/', nav: 'legal' },
  { id: 'dataDeletion', path: '/legal/data-deletion/', nav: 'legal' },
] as const satisfies ReadonlyArray<{ id: keyof Dict['pages']; path: string; nav: 'main' | 'legal' | null }>;

export type RouteId = (typeof ROUTES)[number]['id'] | 'notFound';
export type LegalRouteId = Extract<(typeof ROUTES)[number], { nav: 'legal' }>['id'];

export function routeByPath(path: string): RouteId {
  const normalized = path.endsWith('/') ? path : `${path}/`;
  return ROUTES.find((r) => r.path === normalized)?.id ?? 'notFound';
}

export function pathOf(id: Exclude<RouteId, 'notFound'>): string {
  return ROUTES.find((r) => r.id === id)!.path;
}
