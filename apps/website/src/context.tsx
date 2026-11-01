import { createContext, useContext } from 'react';
import { localePath, t, type Dict, type Locale } from './i18n';
import { pathOf, type RouteId } from './routes';
import { SITE } from './site';

export type PageContext = { locale: Locale; route: RouteId };

const Ctx = createContext<PageContext>({ locale: 'uk', route: 'home' });
export const PageProvider = Ctx.Provider;

/** Current locale, route and dictionary, plus helpers that build locale-aware links. */
export function usePage(): PageContext & {
  d: Dict;
  href: (id: Exclude<RouteId, 'notFound'>, hash?: string) => string;
  dashboard: (mode: 'login' | 'register') => string;
} {
  const ctx = useContext(Ctx);
  return {
    ...ctx,
    d: t(ctx.locale),
    href: (id, hash) => localePath(ctx.locale, pathOf(id)) + (hash ? `#${hash}` : ''),
    dashboard: (mode) => (mode === 'register' ? `${SITE.dashboardUrl}/?mode=register` : `${SITE.dashboardUrl}/`),
  };
}

/** Fills `{name}` tokens: `fmt('{n} replies', { n: 5 })`. */
export function fmt(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
