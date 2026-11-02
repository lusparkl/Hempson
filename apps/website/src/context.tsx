import { createContext, useContext } from 'react';
import { uk, type Dict } from './i18n';
import { pathOf, type RouteId } from './routes';
import { SITE } from './site';

export type PageContext = { route: RouteId };

const Ctx = createContext<PageContext>({ route: 'home' });
export const PageProvider = Ctx.Provider;

/** Current route and dictionary, plus link helpers. */
export function usePage(): PageContext & {
  d: Dict;
  href: (id: Exclude<RouteId, 'notFound'>, hash?: string) => string;
  dashboard: (mode: 'login' | 'register') => string;
} {
  const ctx = useContext(Ctx);
  return {
    ...ctx,
    d: uk,
    href: (id, hash) => pathOf(id) + (hash ? `#${hash}` : ''),
    dashboard: (mode) => (mode === 'register' ? `${SITE.dashboardUrl}/?mode=register` : `${SITE.dashboardUrl}/`),
  };
}

/** Fills `{name}` tokens: `fmt('{n} replies', { n: 5 })`. */
export function fmt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
