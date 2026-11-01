/**
 * Site-wide facts that are not translations. Every `null` is a value the owner must supply before
 * launch; the pages render a visible "to be announced" placeholder instead of inventing it.
 */
export const SITE = {
  name: 'Hepson',
  url: (import.meta.env.VITE_SITE_URL ?? 'http://127.0.0.1:5175').replace(/\/$/, ''),
  dashboardUrl: (import.meta.env.VITE_DASHBOARD_URL ?? 'http://127.0.0.1:5174').replace(/\/$/, ''),
  /** Path of the default Open Graph image inside `public/`. TODO(design): add the file. */
  ogImage: '/og-image.png',
  contacts: {
    email: null as string | null,
    telegram: null as string | null, // e.g. "hepson_support", without @
    phone: null as string | null,
  },
  /**
   * Legal details required on the offer, privacy and refund pages and by payment acquirers.
   * Stays null until the FOP is registered (see "Later" in docs/ROADMAP.md).
   */
  legalEntity: {
    name: null as string | null, // ФОП ПІБ
    taxId: null as string | null, // РНОКПП / ЄДРПОУ
    address: null as string | null,
  },
  /** Date shown as "last updated" on all legal pages, ISO yyyy-mm-dd. */
  legalUpdatedAt: '2026-11-01',
  /** While false, every legal page shows a "draft, not yet reviewed by a lawyer" notice. */
  legalReviewed: false,
};

export type PlanId = 'trial' | 'starter' | 'growth' | 'business' | 'unlimited';

/**
 * Monthly AI-reply caps per plan. Mirrors `PLANS` in packages/database/src/order-kinds.ts
 * (a test keeps them equal); `null` cap = unlimited. Prices in UAH are not decided yet.
 */

export const PRICING: ReadonlyArray<{ id: PlanId; replies: number | null; priceUah: number | null }> = [
  { id: 'trial', replies: 100, priceUah: 0 },
  { id: 'starter', replies: 1000, priceUah: null },
  { id: 'growth', replies: 3000, priceUah: null },
  { id: 'business', replies: 10000, priceUah: null },
  { id: 'unlimited', replies: null, priceUah: null },
];
