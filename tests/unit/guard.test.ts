import { describe, expect, it } from 'vitest';
import { checkReply } from '../../apps/api/src/agent/guard';
import { RunFacts } from '../../apps/api/src/agent/tools';

const facts = (f: { prices?: number[]; stocks?: number[]; quantities?: number[]; productLookups?: number } = {}) => {
  const r = new RunFacts();
  for (const p of f.prices ?? []) r.prices.add(p);
  for (const s of f.stocks ?? []) r.stocks.add(s);
  for (const q of f.quantities ?? []) r.quantities.add(q);
  r.productLookups = f.productLookups ?? 1;
  return r;
};
const check = (reply: string, f = facts(), customerText = '') => checkReply(reply, f, { customerText, maxLength: 1000 });

describe('checkReply', () => {
  it('accepts prices that a tool returned, in several notations', () => {
    const f = facts({ prices: [129_900, 2_599_800] });
    expect(check('Худі коштує 1299 грн', f)).toEqual([]);
    expect(check('Ціна: 1 299,00 грн.', f)).toEqual([]);
    expect(check('₴1299', f)).toEqual([]);
    expect(check('Разом 25 998 UAH', f)).toEqual([]);
  });
  it('blocks a price no tool returned', () => {
    expect(check('Це коштує 999 грн', facts({ prices: [129_900] }))).toEqual([expect.stringContaining('price 999.00')]);
    expect(check('Це коштує $15', facts({ prices: [129_900] }))).toHaveLength(1);
    expect(check('Це коштує 500 грн', facts({ prices: [] }))).toHaveLength(1);
  });
  it('does not read a size or another number next to a price as part of the price', () => {
    expect(check('Розмір 42 за 1299 грн', facts({ prices: [129_900] }))).toEqual([]);
  });
  it('blocks an invented stock figure but accepts tool stock', () => {
    const f = facts({ stocks: [3] });
    expect(check('Залишилось 3 шт', f)).toEqual([]);
    expect(check('Залишилось 7 шт', f)).toHaveLength(1);
    expect(check('в наявності 9', f)).toHaveLength(1);
    expect(check('There are 5 pcs left', f)).toHaveLength(1);
  });
  it('allows echoing a quantity the customer or a quote mentioned', () => {
    expect(check('Добре, 2 шт', facts({ stocks: [3] }), 'Хочу 2 штуки')).toEqual([]);
    expect(check('Оформлюю 4 шт', facts({ stocks: [9], quantities: [4] }))).toEqual([]);
    expect(check('Оформлюю 4 шт', facts({ stocks: [9] }), 'Хочу 2')).toHaveLength(1);
  });
  it('blocks availability claims made without looking at the catalog', () => {
    expect(check('Так, є в наявності!', facts({ productLookups: 0 }))).toHaveLength(1);
    expect(check('Так, є в наявності!', facts({ productLookups: 1 }))).toEqual([]);
    expect(check('Sorry, it is out of stock', facts({ productLookups: 0 }))).toHaveLength(1);
  });
  it('allows a plain reply with no figures', () => {
    expect(check('Вітаю! Чим можу допомогти?', facts({ productLookups: 0 }))).toEqual([]);
  });
  it('enforces the length limit', () => {
    expect(checkReply('x'.repeat(1001), facts(), { customerText: '', maxLength: 1000 })).toHaveLength(1);
  });
});

const withPolicy = (policies: Partial<Record<'delivery' | 'returns' | 'payment' | 'hours', string | null>>, f = facts()) => {
  for (const [topic, text] of Object.entries(policies)) {
    f.policies.set(topic as never, text ?? null);
    for (const n of text?.match(/\d+/g) ?? []) f.policyNumbers.add(Number(n));
  }
  return f;
};

describe('checkReply: policy claims (P3)', () => {
  const returns = 'Повернення або обмін протягом 14 днів з моменту отримання, якщо товар не був у користуванні.';
  const delivery = 'Відправляємо Новою Поштою протягом 1-2 робочих днів після підтвердження.';
  const hours = 'Працюємо з 9:00 до 18:00, без вихідних.';

  it('accepts periods and hours that the policy text contains (uk/ru/en)', () => {
    expect(check('Повернути товар можна протягом 14 днів.', withPolicy({ returns }))).toEqual([]);
    expect(check('Возврат возможен в течение 14 дней.', withPolicy({ returns }))).toEqual([]);
    expect(check('Returns are accepted within 14 days.', withPolicy({ returns }))).toEqual([]);
    expect(check('Відправимо за 1-2 робочі дні.', withPolicy({ delivery }))).toEqual([]);
    expect(check('Ми працюємо з 9 до 18.', withPolicy({ hours }))).toEqual([]);
    expect(check('We are open from 9:00 to 18:00.', withPolicy({ hours }))).toEqual([]);
  });
  it('blocks a delivery time or return period that is not in the policy', () => {
    expect(check('Повернення протягом 30 днів.', withPolicy({ returns }))).toEqual([expect.stringContaining('period 30 is not in the shop policy')]);
    expect(check('Доставка займе 3 дні.', withPolicy({ delivery }))).toHaveLength(1);
    expect(check('Возврат в течение 30 дней.', withPolicy({ returns }))).toHaveLength(1);
    expect(check('Delivery takes 5 business days.', withPolicy({ delivery }))).toHaveLength(1);
    expect(check('Працюємо з 10 до 20.', withPolicy({ hours }))).toHaveLength(2);
  });
  it('blocks periods and topic claims made without get_policy', () => {
    expect(check('Доставка 1-2 дні.')).toEqual([expect.stringContaining('period 1 was stated without the shop policy'), expect.stringContaining('period 2')]);
    expect(check('Повернення можливе, без проблем!')).toEqual([expect.stringContaining('get_policy with topic "returns"')]);
    expect(check('Возврат без проблем.')).toHaveLength(1);
    expect(check('Free shipping on all orders!')).toHaveLength(1);
    expect(check('Є накладений платіж.')).toHaveLength(1);
    expect(check('Працюємо щодня.')).toHaveLength(1);
  });
  it('a topic the shop has no text for may not be discussed; after escalate a holding message may name it', () => {
    expect(check('Повернення можливе.', withPolicy({ returns: null }))).toEqual([expect.stringContaining('no returns policy text')]);
    const f = withPolicy({ returns: null });
    f.escalatedReason = 'Питання про повернення';
    expect(check('Щодо повернення відповість менеджер.', f)).toEqual([]);
    expect(check('Повернення протягом 14 днів, менеджер уточнить.', f)).toHaveLength(1);
  });
  it('payment terms are backed by the policy or by checkout options', () => {
    expect(check('Можна оплатити накладеним платежем.', withPolicy({ payment: 'Оплата: накладений платіж або передоплата на картку.' }))).toEqual([]);
    const f = facts();
    f.paymentMethods = ['cod'];
    expect(check('Доступний накладений платіж.', f)).toEqual([]);
  });
  it('leaves ordinary replies alone', () => {
    expect(check('Оформлюю доставку на відділення №5.', facts())).toEqual([]);
    expect(check('Є розміри від 42 до 46 розміру.', facts())).toEqual([]);
    expect(check('Ціни від 12 до 18 грн.', facts({ prices: [1200, 1800] }))).toEqual([]);
    expect(check('Худі розмір 42 коштує 1299 грн', facts({ prices: [129_900] }))).toEqual([]);
  });
});

describe('checkReply: delivery status and TTN (P4)', () => {
  it('a parcel status needs get_order_status in the same run', () => {
    expect(check('Ваше замовлення вже відправлено!')).toEqual([expect.stringContaining('get_order_status')]);
    expect(check('Посилка в дорозі.')).toHaveLength(1);
    expect(check('Your order has been shipped.')).toHaveLength(1);
    expect(check('Заказ уже отправлен.')).toHaveLength(1);
    const f = facts();
    f.orderStatusLookups = 1;
    expect(check('Посилка в дорозі.', f)).toEqual([]);
  });
  it('a TTN number must come from a tool', () => {
    const f = facts();
    f.orderStatusLookups = 1;
    f.ttns.add('20450000000001');
    expect(check('Ваша ТТН: 20450000000001', f)).toEqual([]);
    expect(check('Ваша ТТН: 20450000009999', f)).toEqual([expect.stringContaining('TTN 20450000009999')]);
  });
});

describe('checkReply: payment claims and links (P5)', () => {
  it('"paid" needs get_order_status to have shown a paid order in this run', () => {
    for (const reply of ['Оплату отримано, дякуємо!', 'Оплата надійшла.', 'Замовлення оплачено.', 'Мы получили оплату.', 'Payment received, thank you!', 'Your order has been paid.'])
      expect(check(reply), reply).toContainEqual(expect.stringContaining('a payment was stated as received'));
    const f = facts();
    f.orderStatusLookups = 1;
    expect(check('Оплату отримано, дякуємо!', f)).toEqual([expect.stringContaining('a payment was stated as received')]);
    f.paidSeen = true;
    expect(check('Оплату отримано, дякуємо!', f)).toEqual([]);
  });
  it('"not paid yet" and questions about payment are not paid claims', () => {
    expect(check('Замовлення ще не оплачене, посилання дійсне до вечора.')).toEqual([]);
    expect(check('Your order is not paid yet.')).toEqual([]);
    expect(check('Ви вже оплатили замовлення?')).toEqual([]);
  });
  it('a payment link must be one get_order_status returned', () => {
    const f = facts();
    f.paymentLinks.add('https://pay.mbnk.biz/p2_test1');
    expect(check('Ось посилання: https://pay.mbnk.biz/p2_test1.', f)).toEqual([]);
    expect(check('Ось посилання: https://pay.mbnk.biz/p2_fake', f)).toEqual([expect.stringContaining('payment link')]);
    expect(check('Оплатіть тут: https://secure.wayforpay.com/pay/x', f)).toHaveLength(1);
    expect(check('Наш сайт: https://shop.example.com/catalog', f)).toEqual([]);
  });
});
