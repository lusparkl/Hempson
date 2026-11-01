import { describe, expect, it } from 'vitest';
import { PLANS } from '../../packages/database/src/order-kinds';
import { ANIMATIONS } from '../../apps/website/src/animations';
import { render, sitemap, targets } from '../../apps/website/src/entry-server';
import { LOCALES, localePath, splitLocale } from '../../apps/website/src/i18n';
import { ru } from '../../apps/website/src/i18n/ru';
import { uk } from '../../apps/website/src/i18n/uk';
import { ROUTES, routeByPath } from '../../apps/website/src/routes';
import { PRICING, SITE } from '../../apps/website/src/site';

/** Lists every key path and array length, so two dictionaries can be compared structurally. */
function shape(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return [`${at}[${v.length}]`, ...v.flatMap((x, i) => shape(x, `${at}[${i}]`))];
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => shape(x, `${at}.${k}`));
  return [`${at}:${typeof v}`];
}

describe('website', () => {
  it('ru copy has exactly the shape of uk copy', () => {
    expect(shape(ru)).toEqual(shape(uk));
  });

  it('pricing caps mirror the server plans', () => {
    expect(Object.fromEntries(PRICING.map((p) => [p.id, p.replies]))).toEqual(PLANS);
  });

  it('uk lives at the root and ru under /ru', () => {
    expect(localePath('uk', '/pricing/')).toBe('/pricing/');
    expect(localePath('ru', '/pricing/')).toBe('/ru/pricing/');
    expect(splitLocale('/ru/pricing/')).toEqual({ locale: 'ru', path: '/pricing/' });
    expect(splitLocale('/ru')).toEqual({ locale: 'ru', path: '/' });
    expect(splitLocale('/rules/')).toEqual({ locale: 'uk', path: '/rules/' });
    expect(routeByPath('/legal/privacy')).toBe('privacy');
    expect(routeByPath('/nope/')).toBe('notFound');
  });

  it('prerenders every route in every locale plus a 404 each', () => {
    const files = targets().map((t) => t.file);
    expect(files).toHaveLength(LOCALES.length * (ROUTES.length + 1));
    expect(files).toContain('index.html');
    expect(files).toContain('ru/index.html');
    expect(files).toContain('legal/data-deletion/index.html');
    expect(files).toContain('ru/404.html');
  });

  it('each page has its title, canonical, hreflang alternates and a switcher link to the other locale', () => {
    for (const { locale, route } of targets()) {
      const page = render(locale, route);
      const other = locale === 'uk' ? 'ru' : 'uk';
      expect(page.head).toContain(`<title>`);
      expect(page.html).toContain('<h1');
      if (route === 'notFound') {
        expect(page.head).toContain('noindex');
        continue;
      }
      const path = ROUTES.find((r) => r.id === route)!.path;
      expect(page.head).toContain(`<link rel="canonical" href="${SITE.url}${localePath(locale, path)}" />`);
      expect(page.head).toContain(`hreflang="x-default" href="${SITE.url}${path}"`);
      expect(page.html.toLowerCase()).toContain(`href="${localePath(other, path)}" hreflang="${other}"`);
    }
  });

  it('legal pages show the draft notice until reviewed', () => {
    expect(SITE.legalReviewed).toBe(false);
    expect(render('uk', 'privacy').html).toContain(uk.common.draftNotice);
  });

  it('every animation in the catalogue has a slot on some page, and every slot is catalogued', () => {
    const used = new Set(targets().flatMap(({ locale, route }) => [...render(locale, route).html.matchAll(/data-anim="([^"]+)"/g)].map((m) => m[1])));
    expect([...used].sort()).toEqual(Object.keys(ANIMATIONS).sort());
  });

  it('sitemap lists every indexable page once per locale', () => {
    expect(sitemap().match(/<loc>/g)).toHaveLength(LOCALES.length * ROUTES.length);
  });
});
