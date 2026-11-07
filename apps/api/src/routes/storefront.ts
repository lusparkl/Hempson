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
const money = (minor: number, currency: string) =>
  `${(minor / 100).toLocaleString('uk-UA', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })} ${currency === 'UAH' ? 'грн' : currency}`;

type Card = { name: string; description: string; image: string | null; minPrice: number; maxPrice: number; currency: string; options: string[] };

/** Active products with at least one active in-stock variant; only those variants count (D36). */
function cards(catalog: CatalogRepository, shopId: string): Card[] {
  const out: Card[] = [];
  for (let offset = 0; offset < MAX_PRODUCTS; offset += 200) {
    const page = catalog.listProducts(shopId, { active: true, limit: 200, offset });
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
    contacts.instagram ? `<a class="btn" href="https://ig.me/m/${esc(contacts.instagram)}" rel="noopener">Написати в Instagram</a>` : '',
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
<style>
:root{--bg:#fafaf9;--card:#fff;--ink:#1c1917;--muted:#57534e;--line:#e7e5e4;--brand:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--card:#1c1917;--ink:#f5f5f4;--muted:#a8a29e;--line:#292524;--brand:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main,footer{max-width:1120px;margin:0 auto;padding:0 16px}header{padding-top:32px}h1{font-size:28px;margin:0 0 8px}
.how{color:var(--muted);margin:0 0 16px}.btns{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.btn{display:inline-block;padding:10px 16px;border-radius:10px;background:var(--brand);color:#fff;text-decoration:none;font-weight:500}
@media (prefers-color-scheme:dark){.btn{color:#052e16}}
ul{list-style:none;margin:0;padding:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;overflow:hidden}
.card img,.noimg{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:var(--line);display:block}
h2{font-size:16px;margin:12px 0 4px}.price{font-weight:600;margin:0}.opts,.desc{color:var(--muted);font-size:14px;margin:6px 0 0}
.empty{color:var(--muted)}.pages{display:flex;gap:8px;margin:24px 0}.pages a,.pages span{padding:6px 12px;border:1px solid var(--line);border-radius:8px;color:var(--ink);text-decoration:none}
.pages span{background:var(--ink);color:var(--bg)}footer{color:var(--muted);font-size:13px;padding:32px 16px}
</style>
</head>
<body>
<header>
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

const notFound = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Не знайдено</title><meta name="robots" content="noindex"></head><body style="font:16px system-ui,sans-serif;padding:32px 16px"><h1 style="font-size:22px">Сторінку не знайдено</h1></body></html>`;

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
    handler: ({ req, params }) => {
      const { shop } = requireRole(req, params.shopId, 'manager');
      return { enabled: shop.storefrontEnabled, url: `${publicUrl}/s/${shop.slug}`, products: cards(catalog, shop.id).length };
    },
  });

  route(app, {
    method: 'GET',
    url: '/s/:slug',
    summary: 'Public storefront page of a shop that turned it on (HTML, Ukrainian)',
    tag: 'storefront',
    auth: 'none',
    params: slugP,
    query: pageQ,
    handler: ({ params, query, reply }) => {
      reply
        .type('text/html; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        // Product images live on the owner's hosts; nothing else loads except this server's chat widget.
        .header(
          'content-security-policy',
          `default-src 'none'; img-src https: http:; style-src 'unsafe-inline'; script-src ${origin}; connect-src ${origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
      const shop = shops.getBySlug(params.slug);
      if (!shop?.storefrontEnabled) {
        reply.status(404).header('cache-control', 'no-store');
        return notFound;
      }
      const all = cards(catalog, shop.id);
      const n = Math.min(query.page ?? 1, Math.max(1, Math.ceil(all.length / PER_PAGE)));
      const wc = webChat.getConfig(shop.id);
      const tg = tgRepo.getChannel(shop.id);
      const ig = igRepo.getChannel(shop.id);
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
