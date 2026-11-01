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
