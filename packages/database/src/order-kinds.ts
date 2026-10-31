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
