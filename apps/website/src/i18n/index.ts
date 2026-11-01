import { ru } from './ru';
import { uk, type Dict } from './uk';

export type { Dict } from './uk';

/** `uk` is the default and lives at the site root; every other locale is a path prefix. */
export const LOCALES = ['uk', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uk';

/** Switcher label; the country code is what visitors expect, the language code is what HTML needs. */
export const LOCALE_LABEL: Record<Locale, string> = { uk: 'UA', ru: 'RU' };
/** Open Graph locale. */
export const OG_LOCALE: Record<Locale, string> = { uk: 'uk_UA', ru: 'ru_UA' };

const DICTS: Record<Locale, Dict> = { uk, ru };

export function t(locale: Locale): Dict {
  return DICTS[locale];
}

/** `localePath('ru', '/pricing/')` = `/ru/pricing/`; the default locale has no prefix. */
export function localePath(locale: Locale, path: string): string {
  return locale === DEFAULT_LOCALE ? path : `/${locale}${path}`;
}

/** Splits `/ru/pricing/` into `{ locale: 'ru', path: '/pricing/' }`. Unknown prefixes belong to the default locale. */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  for (const l of LOCALES) {
    if (l === DEFAULT_LOCALE) continue;
    if (pathname === `/${l}` || pathname.startsWith(`/${l}/`)) return { locale: l, path: pathname.slice(l.length + 1) || '/' };
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}
