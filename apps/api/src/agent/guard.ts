import type { RunFacts } from './tools';

/**
 * Last line of defence against invented facts. The model's text is never authoritative: every price and every stock
 * figure in a reply must have been shown to the model by a tool in this run, otherwise the reply is not sent.
 * This is a heuristic over common Ukrainian/Russian/English phrasings, not a proof; the prompt and tools are the primary control.
 */
const NUM = String.raw`(\d{1,3}(?:[\s\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const CUR = String.raw`(?:грн\.?|гривень|гривні|гривня|₴|uah|usd|eur|\$|€)`;
const PRICE_AFTER = new RegExp(`${NUM}\\s*${CUR}`, 'giu');
const PRICE_BEFORE = new RegExp(`(?:₴|\\$|€)\\s*${NUM}`, 'giu');
const STOCK_CLAIM = new RegExp(`(?:залишил\\w+|в наявності|є в наявності|в наличии|осталось|in stock|available|left)\\s*:?\\s*(\\d+)|(\\d+)\\s*(?:шт\\.?|штук\\w*|pcs|pieces|units)`, 'giu');
const STOCK_ONLY = new RegExp(`(?:залишил\\w+|в наявності|є в наявності|в наличии|осталось|in stock|available|left)\\s*:?\\s*(\\d+)`, 'giu');
const AVAILABILITY_WORDS = /(?:є в наявності|немає в наявності|нема в наявності|в наявності|закінчи\w+|розпродан\w+|в наличии|нет в наличии|in stock|out of stock|available)/iu;

const toMinor = (raw: string) => Math.round(Number.parseFloat(raw.replace(/[\s ]/g, '').replace(',', '.')) * 100);
const numbersIn = (s: string) => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));

export function checkReply(reply: string, facts: RunFacts, opts: { customerText: string; maxLength: number }): string[] {
  const problems: string[] = [];
  if (reply.length > opts.maxLength) problems.push(`reply is ${reply.length} characters; the limit is ${opts.maxLength}. Shorten it.`);

  const prices = [...reply.matchAll(PRICE_AFTER), ...reply.matchAll(PRICE_BEFORE)].map((m) => toMinor(m[1]!)).filter(Number.isFinite);
  for (const p of new Set(prices)) {
    if (!facts.prices.has(p)) problems.push(`price ${(p / 100).toFixed(2)} was not returned by any tool. Quote only prices from tool results; use quote_order for totals.`);
  }

  const customerNumbers = new Set(numbersIn(opts.customerText));
  for (const m of reply.matchAll(STOCK_ONLY)) {
    const n = Number(m[1]);
    if (!facts.stocks.has(n)) problems.push(`stock figure ${n} was not returned by any tool. State only stock from tool results.`);
  }
  for (const m of reply.matchAll(STOCK_CLAIM)) {
    if (m[2] === undefined) continue; // covered by STOCK_ONLY
    const n = Number(m[2]);
    if (!facts.stocks.has(n) && !facts.quantities.has(n) && !customerNumbers.has(n)) problems.push(`quantity ${n} is not backed by a tool result or the customer's message.`);
  }

  if (AVAILABILITY_WORDS.test(reply) && facts.productLookups === 0) problems.push('availability was stated without checking the catalog. Call search_products or get_variant first.');
  return [...new Set(problems)];
}
