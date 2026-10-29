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
