import type { AccountRow, ConversationRepository, ConversationRow, MessageRow, Store } from '@hepson/database';

type Logger = { warn(o: object, m?: string): void };

/** Channel key used in Phase 2 tables for a connector type. Mock data is kept apart from real Instagram data. */
export const channelOf = (type: AccountRow['connectorType']) => (type === 'mock' ? 'mock' : 'instagram');

/**
 * Mirrors Phase 1 connector data (account-scoped) into Phase 2 shop tables for accounts linked to a shop.
 *
 * Normalization: the customer is the other party of the thread, keyed by the provider conversation id (a handle may
 * be missing or change; the thread id is stable). The Phase 1 message id is the external message id, so mirroring is
 * idempotent and the connector's own reconciliation of uncertain sends carries over. Outgoing messages are attributed
 * to `human` without a user: Phase 1 cannot tell the owner typing in the Instagram app from an API client.
 * Mirroring never throws into the connector: a failure is logged and `backfill` repairs it.
 */
export class ChannelBridge {
  constructor(
    private store: Store,
    private conversations: ConversationRepository,
    private log: Logger,
  ) {}

  /** Mirror one stored connector message (new, or whose delivery status changed). */
  mirror(accountId: string, conv: ConversationRow, msg: MessageRow): void {
    try {
      const acc = this.store.getAccount(accountId);
      if (acc?.shopId) this.mirrorOne(acc.shopId, acc, conv, msg);
    } catch (e) {
      this.log.warn({ accountId, err: String(e) }, 'channel mirror failed');
    }
  }

  /** Mirror everything cached for the account. Idempotent. Returns the number of messages processed. */
  backfill(accountId: string): number {
    const acc = this.store.getAccount(accountId);
    if (!acc?.shopId) return 0;
    let n = 0;
    for (const { conversation, messages } of this.store.listAllForMirror(accountId)) {
      this.conversations.ensureConversation(acc.shopId, this.threadOf(acc, conversation));
      for (const m of messages) {
        this.mirrorOne(acc.shopId, acc, conversation, m);
        n++;
      }
    }
    return n;
  }

  backfillAll(): void {
    for (const acc of this.store.listAccounts()) {
      if (!acc.shopId) continue;
      try {
        this.backfill(acc.id);
      } catch (e) {
        this.log.warn({ accountId: acc.id, err: String(e) }, 'channel backfill failed');
      }
    }
  }

  private threadOf(acc: AccountRow, conv: ConversationRow) {
    const external = conv.providerId ?? conv.id;
    return {
      channel: channelOf(acc.connectorType),
      conversationExternalId: external,
      customer: { externalId: external, displayName: conv.title || null, handle: conv.participants.length === 1 ? conv.participants[0] : null },
    };
  }

  private mirrorOne(shopId: string, acc: AccountRow, conv: ConversationRow, m: MessageRow): void {
    const thread = this.threadOf(acc, conv);
    const occurredAt = new Date(m.sentAt ?? m.observedAt).toISOString();
    const attachments = m.attachments.map((a) => ({ kind: a.kind }));
    if (m.direction === 'incoming') {
      this.conversations.ingestMessage(shopId, {
        ...thread,
        externalId: m.id,
        text: m.text,
        attachments: attachments.length || m.text ? attachments : [{ kind: 'other' }],
        occurredAt,
      });
      return;
    }
    const status = m.deliveryStatus === 'sent' ? 'sent' : m.deliveryStatus === 'uncertain' ? 'uncertain' : null;
    if (!status) return; // queued/sending/failed are never stored as messages by the connector
    const { conversation } = this.conversations.ensureConversation(shopId, thread);
    // A reply the sales agent queued shows up here once the connector sends it: adopt that row instead of adding a `human` duplicate.
    // Same for a reply a dashboard member sent through the shop API (Feature 8), and a fixed server text (payment link, customer notice).
    if (m.text && (['ai', 'human', 'system'] as const).some((who) => this.conversations.adoptPendingOutbound(shopId, conversation.id, m.text!, m.id, status, who))) return;
    const r = this.conversations.recordOutbound(shopId, conversation.id, {
      senderType: 'human',
      externalId: m.id,
      text: m.text,
      attachments: attachments.length || m.text ? attachments : [{ kind: 'other' }],
      deliveryStatus: status,
      occurredAt,
    });
    // The connector later confirmed an uncertain send (adopted the real message): carry the resolution over.
    if (r.duplicated && r.message.deliveryStatus === 'uncertain' && status === 'sent') this.conversations.setDeliveryStatus(shopId, r.message.id, 'sent');
  }
}
