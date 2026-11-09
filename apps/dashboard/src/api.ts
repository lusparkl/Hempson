import { useCallback, useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'hepson-session';
export const token = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked: the session lasts until reload */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the shell can show the login form. */
export const UNAUTHORIZED = 'hepson-unauthorized';

/** `bearer` replaces the member's session (operator panel); a 401 on it does not end that session. */
export async function api<T = unknown>(method: string, path: string, body?: unknown, bearer?: string): Promise<T> {
  const t = bearer ?? token.get();
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && t && !bearer) window.dispatchEvent(new Event(UNAUTHORIZED));
    throw new ApiError(json?.error?.code ?? 'ERROR', json?.error?.message ?? res.statusText, res.status);
  }
  return json as T;
}

/** Loads on mount and when `deps` change; optional polling. Keeps the last data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    setData(null);
    void reload();
    if (!pollMs) return;
    const id = setInterval(() => void reload(), pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, pollMs, ...deps]);
  return { data, error, reload };
}

/** The one money format in the dashboard (owner, 2026-11-07): whole units with thousands grouping, `1 280 ₴` for UAH, otherwise `1 280 EUR`. Kopecks are rounded. */
export const moneyShort = (minor: number, currency: string) =>
  `${Math.round(minor / 100).toLocaleString('uk-UA')} ${currency === 'UAH' ? '₴' : currency}`;
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('uk-UA') : '—');
const pad = (n: number) => String(n).padStart(2, '0');
/** `dd.mm, HH:MM` */
export const shortWhen = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const dateOnly = (iso: string) => new Date(iso).toLocaleDateString('uk-UA');
/** A plain `YYYY-MM-DD` day as `dd.mm.yyyy`, with no time zone shift. */
export const dayText = (day: string) => day.split('-').reverse().join('.');
/** Relative time like the design: `5 хв`, `3 год`, `вчора`, otherwise `dd.mm`. */
export const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const min = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'щойно';
  if (min < 60) return `${min} хв`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${Math.floor(min / 60)} год`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'вчора';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
};
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Role = 'owner' | 'manager';
export type Shop = { shopId: string; name: string; slug: string; role: Role; defaultCurrency: string };
export type Me = { user: { userId: string; email: string; displayName: string } };
export type Usage = {
  plan: string;
  aiReplyCap: number | null;
  paidUntil: string | null;
  paidDaysLeft: number | null;
  planExpired: boolean;
  month: string;
  periodEnd: string;
  aiReplies: number;
  remaining: number | null;
  capReached: boolean;
};
const MONTH_IN = ['січні', 'лютому', 'березні', 'квітні', 'травні', 'червні', 'липні', 'серпні', 'вересні', 'жовтні', 'листопаді', 'грудні'];
const MONTH = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
/** `2026-11` → `листопад` (or `листопаді` with `inside`). */
export const monthName = (ym: string, inside = false) => (inside ? MONTH_IN : MONTH)[Number(ym.slice(5, 7)) - 1] ?? ym;
export type AiSettings = { enabled: boolean; operatorStopped: boolean; instructions: string; available: boolean; autonomy: 'approval_required' | 'auto_confirm'; autoConfirmMaxMinor: number | null; autonomyChangedAt: string | null };
export type Escalation = { escalationId: string; conversationId: string; reason: string; createdAt: string };
export type Customer = { customerId: string; channel: string; displayName: string | null; handle: string | null; note: string | null; noteUpdatedAt: string | null; createdAt: string };
export type CustomerCard = Customer & {
  profile: { phone: string | null; city: string | null; orders: { count: number; placed: number; totals: Array<{ currency: string; totalMinor: number }>; lastAt: string | null } };
};
export type LastMessage = { text: string | null; senderType: 'customer' | 'ai' | 'human' | 'system'; attachments: number; at: string };
export type Conv = {
  conversationId: string;
  channel: string;
  lastMessageAt: string | null;
  aiPaused: boolean;
  createdAt: string;
  customer: Customer;
  lastMessage: LastMessage | null;
  /** A customer message the current member has not seen. */
  unread: boolean;
};
export const customerName = (c: Pick<Customer, 'displayName' | 'handle'>) => c.displayName ?? (c.handle ? `@${c.handle.replace(/^@/, '')}` : 'Клієнт');
/** One-line preview of a conversation's newest message, with who wrote it when it was not the customer. */
export const preview = (m: LastMessage | null) => {
  if (!m) return 'Повідомлень ще немає';
  const body = m.text?.trim() || (m.attachments ? 'Вкладення' : '…');
  return m.senderType === 'ai' ? `ШІ: ${body}` : m.senderType === 'human' ? `Ви: ${body}` : body;
};
/** Per-shop order number as shown to members and customers. */
export const orderNo = (n: number) => `№${n}`;

type FeedOrder = { draftId: string; number: number; currency: string; totalMinor: number; customer: string | null };
export type FeedItem = { id: string; at: string; unread: boolean } & (
  | { kind: 'handoff'; conversationId: string; reason: string; resolved: boolean; customer: string | null }
  | ({ kind: 'order_new'; createdBy: 'ai' | 'user'; status: string } & FeedOrder)
  | ({ kind: 'payment_problem'; state: string; flag: string | null } & FeedOrder)
  | ({ kind: 'ttn_problem'; ttnState: 'failed' | 'uncertain'; ttnError: string | null } & FeedOrder)
);
export type Feed = { seenAt: string | null; unread: number; items: FeedItem[] };

export type StatsData = {
  period: { from: string; to: string };
  messages: { incoming: number; outgoingAi: number; outgoingHuman: number; failedOutgoing: number };
  conversations: { active: number; newCustomers: number; aiPausedNow: number };
  ai: { runs: number; byStatus: Record<string, number>; modelRequests: number; inputTokens: number; outputTokens: number; replyRate: number | null };
  escalations: { opened: number; resolved: number; openNow: number; avgResolutionSeconds: number | null };
  orderDrafts: { byStatus: Record<string, number>; approved: Array<{ currency: string; count: number; totalMinor: number }> };
  /** Shop default currency; `daily[].revenueMinor` is in it. */
  currency: string;
  /** Every UTC day of the period, zeros included. */
  daily: Array<{ date: string; runs: number; replied: number; escalated: number; inputTokens: number; outputTokens: number; newCustomers: number; outgoingHuman: number; approved: number; revenueMinor: number }>;
  funnel: { conversations: number; drafts: number; approved: number; paid: number; shipped: number; delivered: number };
  orderSources: { drafts: { ai: number; human: number }; approved: { ai: number; human: number }; approvedBy: { human: number; auto: number } };
  usage: Usage;
};
export const statsUrl = (shopId: string, days: number, offsetDays = 0) => {
  const to = Date.now() - offsetDays * 86_400_000;
  const q = new URLSearchParams({ from: new Date(to - days * 86_400_000).toISOString(), ...(offsetDays ? { to: new Date(to).toISOString() } : {}) });
  return `/v1/shops/${shopId}/stats?${q}`;
};
/** Approved revenue in the shop currency (minor units), or the first currency present. */
export const revenue = (s: StatsData, currency: string) => s.orderDrafts.approved.find((a) => a.currency === currency) ?? s.orderDrafts.approved[0] ?? { currency, count: 0, totalMinor: 0 };
