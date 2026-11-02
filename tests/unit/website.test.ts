import { describe, expect, it } from 'vitest';
import { PLANS } from '../../packages/database/src/order-kinds';
import { ANIMATIONS } from '../../apps/website/src/animations';
import { render, sitemap, targets } from '../../apps/website/src/entry-server';
import { uk } from '../../apps/website/src/i18n/uk';
import { ROUTES, routeByPath } from '../../apps/website/src/routes';
import { PRICING, SITE } from '../../apps/website/src/site';

describe('website', () => {
  it('pricing caps mirror the server plans', () => {
    expect(Object.fromEntries(PRICING.map((p) => [p.id, p.replies]))).toEqual(PLANS);
  });

  it('resolves paths to routes; there is no /ru copy', () => {
    expect(routeByPath('/pricing/')).toBe('pricing');
    expect(routeByPath('/ru/pricing/')).toBe('notFound');
    expect(routeByPath('/legal/privacy')).toBe('privacy');
    expect(routeByPath('/nope/')).toBe('notFound');
  });

  it('prerenders every route plus a 404, all in Ukrainian only', () => {
    const files = targets().map((t) => t.file);
    expect(files).toHaveLength(ROUTES.length + 1);
    expect(files).toContain('index.html');
    expect(files).toContain('legal/data-deletion/index.html');
    expect(files).toContain('404.html');
    expect(files.some((f) => f.startsWith('ru/'))).toBe(false);
  });

  it('each page has its title, canonical and no language alternates', () => {
    for (const { route } of targets()) {
      const page = render(route);
      expect(page.head).toContain(`<title>`);
      expect(page.html).toContain('<h1');
      if (route === 'notFound') {
        expect(page.head).toContain('noindex');
        continue;
      }
      const path = ROUTES.find((r) => r.id === route)!.path;
      expect(page.head).toContain(`<link rel="canonical" href="${SITE.url}${path}" />`);
      expect(page.head).not.toContain('hreflang');
      expect(page.html).not.toContain('hreflang');
    }
  });

  it('legal pages show the draft notice until reviewed', () => {
    expect(SITE.legalReviewed).toBe(false);
    expect(render('privacy').html).toContain(uk.common.draftNotice);
  });

  it('every animation in the catalogue has a slot on some page, and every slot is catalogued', () => {
    const used = new Set(targets().flatMap(({ route }) => [...render(route).html.matchAll(/data-anim="([^"]+)"/g)].map((m) => m[1])));
    expect([...used].sort()).toEqual(Object.keys(ANIMATIONS).sort());
  });

  it('sitemap lists every indexable page once', () => {
    expect(sitemap().match(/<loc>/g)).toHaveLength(ROUTES.length);
  });
});
