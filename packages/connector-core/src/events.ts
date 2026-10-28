import { z } from 'zod';

export const EVENT_TYPES = [
  'message.received',
  'message.sent',
  'conversation.updated',
  'session.connected',
  'session.login_required',
  'session.checkpoint_required',
  'connector.degraded',
  'connector.error',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ConnectorEventSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  /** Monotonic per account, starting at 1. Use for replay (`afterSequence`). */
  sequence: z.number().int().positive(),
  type: z.enum(EVENT_TYPES),
  occurredAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
});
export type ConnectorEvent = z.infer<typeof ConnectorEventSchema>;
