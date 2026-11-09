import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  effectivePrice,
  type AuthRepository,
  type CatalogRepository,
  type InstagramRepository,
  type ProductWithVariants,
  type ShopRepository,
  type ShopRow,
  type TelegramRepository,
  type WebChatRepository,
} from '@hepson/database';
import { route } from './define';
import { makeRequireRole } from './shops';

const slugP = z.object({ slug: z.string().min(1).max(63) });
const pageQ = z.object({ page: z.coerce.number().int().min(1).max(100).optional() });

const PER_PAGE = 48;
/** Products read per storefront render (5 catalog pages of 200). */
const MAX_PRODUCTS = 1000;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const WEB_IMAGE = /^https?:\/\/[^\s"'<>]+$/i;
/** Same format as the dashboard: whole units with grouping, `1 280 ₴`. */
const money = (minor: number, currency: string) => `${Math.round(minor / 100).toLocaleString('uk-UA')} ${currency === 'UAH' ? '₴' : currency}`;

/** Geist from the design system (`packages/ui`), served here so the page loads nothing from third parties. Cyrillic and Latin subsets. */
const FONTS: Record<string, Buffer> = Object.fromEntries(
  ['cyrillic', 'latin'].map((sub) => [sub, readFileSync(new URL(`../../../../packages/ui/src/fonts/geist-${sub}-wght-normal.woff2`, import.meta.url))]),
);
/** Design-system tokens (packages/ui/src/styles.css) the page uses, light theme as in the design. */
const STYLE = `
@font-face{font-family:'Geist';font-weight:100 900;font-display:swap;src:url('/s/_fonts/geist-cyrillic.woff2') format('woff2');unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:'Geist';font-weight:100 900;font-display:swap;src:url('/s/_fonts/geist-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+20B4,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
:root{--brand-50:#f1f0ff;--brand-600:#533afd;--brand-700:#4228d6;--ink-900:#0a2540;--ink-700:#425466;--ink-600:#5a6d86;--ink-500:#7b8ca3;--ink-100:#e8edf3;--ink-50:#f6f9fc;--border-default:#dce3ec;--border-strong:#c9d2df}
*{box-sizing:border-box}
body{margin:0;background:var(--ink-50);color:var(--ink-700);font:16px/1.45 'Geist','Helvetica Neue',Arial,sans-serif;letter-spacing:-0.01em;-webkit-font-smoothing:antialiased}
header,main,footer{max-width:1232px;margin:0 auto;padding:0 16px}
header{padding-top:48px;padding-bottom:8px}
.eyebrow{font-size:12px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:var(--brand-600);margin:0 0 12px}
h1{font-size:36px;font-weight:400;line-height:1.08;letter-spacing:-0.035em;color:var(--ink-900);margin:0 0 12px}
.how{color:var(--ink-600);margin:0 0 20px;max-width:640px}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}
.btn{display:inline-flex;align-items:center;height:40px;padding:0 16px;border-radius:4px;background:var(--brand-600);color:#fff;text-decoration:none;font-size:15px;font-weight:500;white-space:nowrap}
.btn:hover{background:var(--brand-700)}
.btn.secondary{background:#fff;color:var(--brand-700);border:1px solid var(--border-strong)}
.btn.secondary:hover{background:var(--brand-50);border-color:var(--brand-600)}
ul{list-style:none;margin:0;padding:0;display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:#fff;border:1px solid var(--border-default);border-radius:8px;padding:12px;overflow:hidden}
.card img,.noimg{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;background:var(--brand-50);display:block}
h2{font-size:16px;font-weight:500;letter-spacing:-0.015em;color:var(--ink-900);margin:14px 4px 4px}
.price{font-size:18px;font-weight:500;color:var(--ink-900);margin:0 4px}
.opts,.desc{color:var(--ink-600);font-size:14px;margin:6px 4px 0}
.empty{color:var(--ink-600)}
.pages{display:flex;flex-wrap:wrap;gap:6px;margin:32px 0}
.pages a,.pages span{min-width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;padding:0 10px;border:1px solid var(--border-default);border-radius:4px;background:#fff;color:var(--ink-700);text-decoration:none;font-size:14px}
.pages a:hover{background:var(--brand-50)}
.pages span{border-color:var(--brand-600);background:var(--brand-50);color:var(--brand-700);font-weight:500}
footer{color:var(--ink-500);font-size:13px;padding-top:40px;padding-bottom:40px}
@media (max-width:600px){header{padding-top:32px}h1{font-size:28px}ul{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{padding:8px}h2{font-size:14px;margin:10px 2px 2px}.price{font-size:16px;margin:0 2px}.opts,.desc{font-size:13px;margin:4px 2px 0}.desc{display:none}}
`;

type Card = { name: string; description: string; image: string | null; minPrice: number; maxPrice: number; currency: string; options: string[] };

/** Active products with at least one active in-stock variant; only those variants count (D36). */
async function cards(catalog: CatalogRepository, shopId: string): Promise<Card[]> {
  const out: Card[] = [];
  for (let offset = 0; offset < MAX_PRODUCTS; offset += 200) {
    const page = await catalog.listProducts(shopId, { active: true, limit: 200, offset });
    for (const pw of page.items) {
      const c = card(pw);
      if (c) out.push(c);
    }
    if (page.items.length < 200) break;
  }
  return out;
}
function card({ product: p, variants }: ProductWithVariants): Card | null {
  const live = variants.filter((v) => v.active && v.stock > 0);
  if (!live.length) return null;
  const prices = live.map((v) => effectivePrice(p, v));
  const image = p.media[0] && WEB_IMAGE.test(p.media[0]) && p.media[0].length <= 2048 ? p.media[0] : null;
  const options = [...new Set(live.map((v) => Object.values(v.options).join(' / ')).filter(Boolean))].slice(0, 12);
  return { name: p.name, description: p.description.slice(0, 300), image, minPrice: Math.min(...prices), maxPrice: Math.max(...prices), currency: p.currency, options };
}

type Contacts = { widgetKey: string | null; telegram: string | null; instagram: string | null };

function page(shop: ShopRow, all: Card[], n: number, contacts: Contacts, publicUrl: string): string {
  const pages = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const items = all.slice((n - 1) * PER_PAGE, n * PER_PAGE);
  const grid = items
    .map(
      (c) => `<li class="card">
${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" referrerpolicy="no-referrer">` : '<div class="noimg" aria-hidden="true"></div>'}
<h2>${esc(c.name)}</h2>
<p class="price">${c.minPrice === c.maxPrice ? '' : 'від '}${esc(money(c.minPrice, c.currency))}</p>
${c.options.length ? `<p class="opts">${c.options.map(esc).join(' · ')}</p>` : ''}
${c.description ? `<p class="desc">${esc(c.description)}</p>` : ''}
</li>`,
    )
    .join('\n');
  const links = [
    contacts.telegram ? `<a class="btn" href="https://t.me/${esc(contacts.telegram)}" rel="noopener">Написати в Telegram</a>` : '',
    contacts.instagram ? `<a class="btn${contacts.telegram ? ' secondary' : ''}" href="https://ig.me/m/${esc(contacts.instagram)}" rel="noopener">Написати в Instagram</a>` : '',
  ].join('');
  const how = contacts.widgetKey || links ? 'Щоб замовити, напишіть нам: асистент підбере розмір, порахує суму й оформить замовлення.' : 'Замовлення приймає магазин.';
  const nav =
    pages > 1
      ? `<nav class="pages" aria-label="Сторінки">${Array.from({ length: pages }, (_, i) => (i + 1 === n ? `<span aria-current="page">${i + 1}</span>` : `<a href="?page=${i + 1}">${i + 1}</a>`)).join('')}</nav>`
      : '';
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(shop.name)}: каталог</title>
<meta name="robots" content="index, follow">
<style>${STYLE}</style>
</head>
<body>
<header>
<p class="eyebrow">Каталог</p>
<h1>${esc(shop.name)}</h1>
<p class="how">${how}</p>
${links ? `<div class="btns">${links}</div>` : ''}
</header>
<main>
${items.length ? `<ul>\n${grid}\n</ul>` : '<p class="empty">Зараз немає товарів у наявності.</p>'}
${nav}
</main>
<footer>Ціни й наявність актуальні на момент перегляду. Каталог на Hepson.</footer>
${contacts.widgetKey ? `<script src="${esc(publicUrl)}/widget/web-chat.js" data-key="${esc(contacts.widgetKey)}" data-lang="uk" async></script>` : ''}
</body>
</html>`;
}

const notFound = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Не знайдено</title><meta name="robots" content="noindex"><style>${STYLE}</style></head><body><header><p class="eyebrow">404</p><h1>Сторінку не знайдено</h1></header></body></html>`;

/**
 * P9 storefront (D36, D42): a public read-only catalog page at `/s/<slug>`, off until the owner turns it on. Shows active
 * in-stock products only, with no stock counts. Ordering goes through the shop's chats (website chat widget on this page,
 * Telegram bot, Instagram DM), so there is one checkout path with the same guard and approval rules.
 */
export function registerStorefrontRoutes(
  app: FastifyInstance,
  deps: {
    shops: ShopRepository;
    auth: AuthRepository;
    catalog: CatalogRepository;
    webChat: WebChatRepository;
    tgRepo: TelegramRepository;
    igRepo: InstagramRepository;
    publicUrl: string;
  },
) {
  const { shops, auth, catalog, webChat, tgRepo, igRepo, publicUrl } = deps;
  const origin = new URL(publicUrl).origin;
  const requireRole = makeRequireRole(shops, auth);

  route(app, {
    method: 'GET',
    url: '/v1/shops/:shopId/storefront',
    summary: 'Storefront state: on/off (set with PATCH /v1/shops/:shopId storefrontEnabled), its public address and how many products it shows (any member)',
    tag: 'storefront',
    auth: 'user',
    params: z.object({ shopId: z.uuid() }),
    handler: async ({ req, params }) => {
      const { shop } = await requireRole(req, params.shopId, 'manager');
      return { enabled: shop.storefrontEnabled, url: `${publicUrl}/s/${shop.slug}`, products: (await cards(catalog, shop.id)).length };
    },
  });

  // Not in the API registry: static font files for the storefront page.
  app.get<{ Params: { file: string } }>('/s/_fonts/:file', (req, reply) => {
    const m = /^geist-(cyrillic|latin)\.woff2$/.exec(req.params.file);
    if (!m) return reply.status(404).send();
    return reply.type('font/woff2').header('cache-control', 'public, max-age=31536000, immutable').header('access-control-allow-origin', '*').send(FONTS[m[1]!]);
  });

  route(app, {
    method: 'GET',
    url: '/s/:slug',
    summary: 'Public storefront page of a shop that turned it on (HTML, Ukrainian)',
    tag: 'storefront',
    auth: 'none',
    params: slugP,
    query: pageQ,
    handler: async ({ params, query, reply }) => {
      reply
        .type('text/html; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        // Product images live on the owner's hosts; nothing else loads except this server's chat widget.
        .header(
          'content-security-policy',
          `default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; font-src ${origin}; script-src ${origin}; connect-src ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
      const shop = await shops.getBySlug(params.slug);
      if (!shop?.storefrontEnabled) {
        reply.status(404).header('cache-control', 'no-store');
        return notFound;
      }
      const all = await cards(catalog, shop.id);
      const n = Math.min(query.page ?? 1, Math.max(1, Math.ceil(all.length / PER_PAGE)));
      const wc = await webChat.getConfig(shop.id);
      const tg = await tgRepo.getChannel(shop.id);
      const ig = await igRepo.getChannel(shop.id);
      const contacts: Contacts = {
        widgetKey: wc?.enabled ? wc.widgetKey : null,
        telegram: tg?.status === 'connected' && tg.botUsername && /^\w{5,64}$/.test(tg.botUsername) ? tg.botUsername : null,
        instagram: ig?.status === 'connected' && ig.username && /^[\w.]{1,30}$/.test(ig.username) ? ig.username : null,
      };
      reply.header('cache-control', 'public, max-age=60');
      return page(shop, all, n, contacts, publicUrl);
    },
  });
}
