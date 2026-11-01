import type { PolicyTopic } from '@hepson/database';
import type { RunFacts } from './tools';

/**
 * Last line of defence against invented facts. The model's text is never authoritative: every price and every stock
 * figure in a reply must have been shown to the model by a tool in this run, otherwise the reply is not sent. The same
 * holds for policy claims (periods, hours, returns/payment/free-delivery terms: `get_policy`, P3) and for delivery status
 * and TTN numbers (`get_order_status`, P4), and for payment state and payment links (`get_order_status`, P5).
 * This is a heuristic over common Ukrainian/Russian/English phrasings, not a proof; the prompt and tools are the primary control.
 */
const NUM = String.raw`(\d{1,3}(?:[\s\u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const CUR = String.raw`(?:грн\.?|гривень|гривні|гривня|₴|uah|usd|eur|\$|€)`;
const PRICE_AFTER = new RegExp(`${NUM}\\s*${CUR}`, 'giu');
const PRICE_BEFORE = new RegExp(`(?:₴|\\$|€)\\s*${NUM}`, 'giu');
const STOCK_CLAIM = new RegExp(`(?:залишил\\w+|в наявності|є в наявності|в наличии|осталось|in stock|available|left)\\s*:?\\s*(\\d+)|(\\d+)\\s*(?:шт\\.?|штук\\w*|pcs|pieces|units)`, 'giu');
const STOCK_ONLY = new RegExp(`(?:залишил\\w+|в наявності|є в наявності|в наличии|осталось|in stock|available|left)\\s*:?\\s*(\\d+)`, 'giu');
const AVAILABILITY_WORDS = /(?:є в наявності|немає в наявності|нема в наявності|в наявності|закінчи\w+|розпродан\w+|в наличии|нет в наличии|in stock|out of stock|available)/iu;

// P3: policy claims. `\p{L}*` instead of `\w`, which is ASCII-only even with the `u` flag.
const DURATION = /(\d+)(?:\s*[-–—]\s*(\d+))?\s*(?:робоч\p{L}*\s+|рабоч\p{L}*\s+|business\s+|working\s+|календарн\p{L}*\s+)?(?:дн\p{L}*|день|доб\p{L}*|тиж\p{L}*|недел\p{L}*|місяц\p{L}*|месяц\p{L}*|годин\p{L}*|час(?:а|ов)?|days?|weeks?|months?|hours?)(?!\p{L})/giu;
const HOURS_RANGE = /(?:^|[^\p{L}])(?:з|с|from|від|от)\s*(\d{1,2})(?:[:.]\d{2})?\s*(?:до|to|-|–)\s*(\d{1,2})(?:[:.]\d{2})?(?!\d|\s*(?:грн|гривен|гривн|uah|₴|\$|€|шт|pcs|%|кг|kg|см|cm|розмір|size|дн|day|тиж|week))/giu;
const CLOCK = /(?<!\d)(\d{1,2}):\d{2}(?!\d)/gu;
const TOPIC_WORDS: Array<[PolicyTopic, RegExp]> = [
  ['returns', /(?:поверненн\p{L}*|повернут\p{L}*|обмін\p{L}*|обміня\p{L}*|возврат\p{L}*|вернуть|обмен\p{L}*|обменя\p{L}*|(?<!\p{L})(?:refunds?|returns?|exchanges?)(?!\p{L}))/iu],
  ['delivery', /(?:безкоштовн\p{L}*\s+доставк|доставк\p{L}*\s+(?:є\s+)?безкоштовн|бесплатн\p{L}*\s+доставк|доставк\p{L}*\s+бесплатн|free\s+(?:shipping|delivery))/iu],
  ['payment', /(?:накладен\p{L}*\s+платіж\p{L}*|наложен\p{L}*\s+плат\p{L}*|післяплат\p{L}*|передоплат\p{L}*|предоплат\p{L}*|оплат\p{L}*\s+(?:при|під час)\s+отриманн\p{L}*|cash on delivery|prepay\p{L}*|pre-?payment)/iu],
  ['hours', /(?:працюємо|графік\p{L}*\s+робот|вихідн\p{L}*|работаем|график\p{L}*\s+работ|выходн\p{L}*|opening hours|we are open|business hours)/iu],
];
// P4: delivery-status claims and TTN numbers (NP waybills are 14 digits starting with 20 or 59).
const DELIVERY_STATUS = /(?:відправили|відправлено|вже в дорозі|в дорозі|прибул\p{L}*|доставлено|отримано|у відділенні|отправили|отправлен\p{L}*|в пути|доставлен\p{L}*|прибыл\p{L}*|(?<!\p{L})(?:shipped|delivered|arrived|on (?:its|the) way|in transit)(?!\p{L}))/iu;
const TTN = /(?<!\d)(?:20|59)\d{12}(?!\d)/g;
// P5: "paid" claims and payment links. Questions ("ви вже оплатили?") are not claims, so only statement forms are listed.
const PAID_CLAIM = /(?:оплачен\p{L}*|оплату\s+(?:отримано|отримали|зараховано|підтверджено)|оплата\s+(?:надійшла|пройшла|отримана|зарахована|підтверджена)|отримали\s+(?:вашу\s+)?оплату|оплата\s+прошла|получили\s+(?:вашу\s+)?оплату|оплата\s+поступила|(?<!\p{L})(?:payment\s+(?:received|confirmed|went through|is complete)|(?:has been|is|was)\s+paid|fully paid)(?!\p{L}))/iu;
const NOT_PAID = /(?:не\s+оплачен\p{L}*|неоплачен\p{L}*|не\s+оплачено|not\s+(?:yet\s+)?(?:been\s+)?paid|unpaid)/iu;
const LINK = /https?:\/\/[^\s)>\]"']+/giu;
const PAYMENT_HOST = /(?:^|\.)(?:mbnk\.biz|monobank\.ua|wayforpay\.com|liqpay\.ua|privatbank\.ua|fondy\.eu|portmone\.com\.ua)$/i;

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

  problems.push(...checkPolicyClaims(reply, facts), ...checkDeliveryClaims(reply, facts), ...checkPaymentClaims(reply, facts));
  return [...new Set(problems)];
}

/**
 * P3: a period ("14 днів", "1-2 дні"), opening hours or a policy topic in a reply must come from `get_policy` in the same
 * run. Numbers must appear in a returned policy text. A holding message after `escalate` may name the topic, never a figure.
 */
function checkPolicyClaims(reply: string, facts: RunFacts): string[] {
  const problems: string[] = [];
  const looked = [...facts.policies.values()].some((v) => v !== null);
  const figure = (n: number, what: string) => {
    if (facts.policyNumbers.has(n)) return;
    problems.push(looked ? `${what} ${n} is not in the shop policy text. Quote only what get_policy returned, or call escalate.` : `${what} ${n} was stated without the shop policy. Call get_policy first, or escalate.`);
  };
  for (const m of reply.matchAll(DURATION)) {
    figure(Number(m[1]), 'period');
    if (m[2] !== undefined) figure(Number(m[2]), 'period');
  }
  for (const m of reply.matchAll(HOURS_RANGE)) {
    figure(Number(m[1]), 'time');
    figure(Number(m[2]), 'time');
  }
  for (const m of reply.matchAll(CLOCK)) figure(Number(m[1]), 'time');
  if (facts.escalatedReason === null)
    for (const [topic, re] of TOPIC_WORDS) {
      if (!re.test(reply)) continue;
      if (facts.policies.get(topic)) continue;
      if (topic === 'payment' && facts.paymentMethods?.length) continue;
      problems.push(
        facts.policies.has(topic)
          ? `the shop has no ${topic} policy text, so nothing may be said about it. Call escalate instead.`
          : `${topic} terms were mentioned without the shop policy. Call get_policy with topic "${topic}" first.`,
      );
    }
  return problems;
}

/** P4: the state of a parcel or a TTN number must come from `get_order_status` in the same run. */
function checkDeliveryClaims(reply: string, facts: RunFacts): string[] {
  const problems: string[] = [];
  if (DELIVERY_STATUS.test(reply) && facts.orderStatusLookups === 0) problems.push('a delivery status was stated without checking the order. Call get_order_status first.');
  for (const m of reply.matchAll(TTN)) if (!facts.ttns.has(m[0])) problems.push(`TTN ${m[0]} was not returned by get_order_status. Quote only TTNs from tool results.`);
  return problems;
}

/**
 * P5 (D24): "paid / оплачено / payment received" needs `get_order_status` to have returned a paid order in this run, and a
 * payment link may appear only as `get_order_status` returned it. A "not paid yet" statement is not a paid claim.
 */
function checkPaymentClaims(reply: string, facts: RunFacts): string[] {
  const problems: string[] = [];
  if (PAID_CLAIM.test(reply.replace(new RegExp(NOT_PAID.source, 'giu'), ' ')) && !facts.paidSeen) problems.push('a payment was stated as received without get_order_status showing a paid order. Call get_order_status; never say an order is paid otherwise.');
  for (const m of reply.matchAll(LINK)) {
    let host = '';
    try {
      host = new URL(m[0]).hostname;
    } catch {
      continue;
    }
    if (PAYMENT_HOST.test(host) && !facts.paymentLinks.has(m[0].replace(/[.,;:!?]+$/, ''))) problems.push('a payment link was written that get_order_status did not return. Never write payment links yourself; the shop system sends them.');
  }
  return problems;
}
