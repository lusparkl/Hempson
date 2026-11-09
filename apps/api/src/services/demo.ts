import {
  seedShop,
  type AgentRepository,
  type AuthRepository,
  type CatalogRepository,
  type CreateProductInput,
  type DbHandle,
  type PolicyRepository,
  type PolicyTopic,
  type ShopRepository,
} from '@hepson/database';

export const DEMO_SLUG = 'hepson-demo';

const NOTES =
  'Це демонстраційний магазин на сайті Hepson, усі товари тестові. Реальні замовлення тут не оформлюються: якщо клієнт хоче купити, покажи ціну й наявність, а потім скажи, що це демо, і запропонуй зареєструватися в Hepson.';

const POLICIES: Record<PolicyTopic, string> = {
  delivery: 'Доставка Новою поштою по Україні, зазвичай 1-3 дні. Вартість за тарифами перевізника.',
  returns: 'Повернення або обмін протягом 14 днів, якщо товар не був у використанні.',
  payment: 'Онлайн-оплата карткою через monobank або накладений платіж у відділенні Нової пошти.',
  hours: 'Працюємо щодня з 9:00 до 20:00.',
};

const PRODUCTS: CreateProductInput[] = [
  {
    name: 'Худі Classic',
    description: 'Тепле худі з бавовни з начосом, вільний крій. Колір: графіт.',
    priceMinor: 129_900,
    currency: 'UAH',
    variants: [
      { sku: 'DEMO-HOODIE-S', options: { розмір: 'S' }, stock: 4 },
      { sku: 'DEMO-HOODIE-M', options: { розмір: 'M' }, stock: 7 },
      { sku: 'DEMO-HOODIE-L', options: { розмір: 'L' }, stock: 0 },
    ],
  },
  {
    name: 'Футболка Basic',
    description: 'Базова футболка зі 100% бавовни. Колір: білий.',
    priceMinor: 54_900,
    currency: 'UAH',
    variants: [
      { sku: 'DEMO-TEE-M', options: { розмір: 'M' }, stock: 12 },
      { sku: 'DEMO-TEE-L', options: { розмір: 'L' }, stock: 5 },
    ],
  },
  {
    name: 'Шопер Canvas',
    description: 'Міцна сумка з канвасу на довгих ручках, вміщує формат A4.',
    priceMinor: 39_900,
    currency: 'UAH',
    sku: 'DEMO-TOTE',
    stock: 20,
  },
  {
    name: 'Шкарпетки Warm, 3 пари',
    description: 'Набір теплих шкарпеток із вовною, розмір 39-42.',
    priceMinor: 29_900,
    currency: 'UAH',
    sku: 'DEMO-SOCKS',
    stock: 15,
  },
];

/**
 * The shop behind the public demo (D45): test catalog, no members, created once. A shop with this slug that has members
 * belongs to a real owner, so the demo stays off (null) rather than exposing that shop's catalog.
 */
export async function ensureDemoShop(d: {
  handle: DbHandle;
  shops: ShopRepository;
  auth: AuthRepository;
  catalog: CatalogRepository;
  policies: PolicyRepository;
  agent: AgentRepository;
}): Promise<string | null> {
  const existing = await d.shops.getBySlug(DEMO_SLUG);
  if (existing) return (await d.auth.listMembers(existing.id)).length ? null : existing.id;
  return await seedShop(d, { name: 'Hepson Demo', slug: DEMO_SLUG }, PRODUCTS, POLICIES, NOTES);
}
