import { z } from 'zod';

export const AccountIdParams = z.object({ accountId: z.uuid() });
export const ConversationParams = AccountIdParams.extend({ conversationId: z.uuid() });
export const OutboxParams = AccountIdParams.extend({ outboxId: z.uuid() });
export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() });

export const CreateAccountBody = z.object({
  label: z.string().trim().min(1).max(80),
  connectorType: z.enum(['mock', 'instagram-browser']).default('mock'),
  /** Required (true) for real accounts: records the shop owner's express authorization. */
  consentConfirmed: z.boolean(),
  expectedInstagramHandle: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9._]+$/)
    .optional(),
});
export const SettingsBody = z.object({ outboundEnabled: z.boolean() });
export const SendBody = z.object({
  text: z.string().max(10_000),
  idempotencyKey: z.string().min(8).max(128),
  dryRun: z.boolean().optional(),
});
export const ForgetBody = z.object({ confirmLabel: z.string() });
export const DeleteDataBody = z.object({ confirmLabel: z.string() });
export const SessionStartBody = z.object({ interactive: z.boolean().default(true) }).default({ interactive: true });
export const EventsQuery = z.object({ afterSequence: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) });
export const CreateKeyBody = z.object({ name: z.string().trim().min(1).max(60) });
export const DevInjectBody = z.object({ providerConversationId: z.string(), text: z.string().nullable(), imageOnly: z.boolean().optional() });
export const DevStatusBody = z.object({ status: z.enum(['connected', 'login_required', 'checkpoint_required']) });
export const DevPlanBody = z.object({
  outcomes: z
    .array(z.enum(['sent', 'failed', 'uncertain', 'throw_ui_changed']))
    .min(1)
    .max(10),
});
export const Empty = z.object({}).passthrough();
