/** Order lifecycle (D25). Transitions are made by server code or a member, never by the model. */
export const ORDER_STATUSES = [
  'pending_approval',
  'approved',
  'awaiting_payment',
  'cod_confirmed',
  'paid',
  'shipped',
  'delivered',
  'returning',
  'returned',
  'rejected',
  'cancelled',
  'refund_requested',
] as const;
export const PAYMENT_METHODS = ['cod', 'prepaid'] as const;
export const POLICY_TOPICS = ['delivery', 'returns', 'payment', 'hours'] as const;
/** Payment providers with the shop's own merchant credentials (D24). WayForPay comes later. */
export const PAYMENT_PROVIDERS = ['monobank'] as const;
/**
 * One payment link attempt (P5). `creating`: claimed before the provider call. `create_failed`: no invoice is known, a
 * member may create a new link. `removed`: Hepson deactivated the unpaid invoice. The rest mirror the provider status.
 */
export const PAYMENT_STATES = ['creating', 'create_failed', 'created', 'processing', 'hold', 'success', 'failure', 'reversed', 'expired', 'removed'] as const;
/**
 * Customer notices (P6): one fixed server text to the customer per (order, event). Prepaid approval has no `confirmed`
 * notice: its payment link message (P5) is the confirmation; the payment reminder is also P5's.
 */
export const CUSTOMER_NOTICE_EVENTS = ['confirmed', 'rejected', 'paid', 'shipped', 'delivered'] as const;
/**
 * `pending`: queued in the transaction of the status change. `sending`: claimed by one sender (left there by a crash, it
 * becomes `uncertain` at startup; never retried). `skipped`: deliberately not sent (stale, or the order was cancelled).
 */
export const CUSTOMER_NOTICE_STATES = ['pending', 'sending', 'sent', 'uncertain', 'failed', 'skipped'] as const;
/**
 * Hepson plans (P7): monthly AI-reply caps, enforced without billing (no FOP yet). `null` = no cap. The numbers are
 * starting values for pilots, not prices; the operator assigns a plan per shop (or a custom cap).
 */
export const PLANS = { trial: 100, starter: 1000, growth: 3000, business: 10000, unlimited: null } as const satisfies Record<string, number | null>;
export const PLAN_NAMES = Object.keys(PLANS) as Array<keyof typeof PLANS>;
