export const CONNECTOR_STATUSES = ['disconnected', 'login_required', 'connecting', 'connected', 'degraded', 'checkpoint_required', 'failed'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export type MessageDirection = 'incoming' | 'outgoing';
export const DELIVERY_STATUSES = ['observed', 'queued', 'sending', 'sent', 'uncertain', 'failed'] as const;
export type MessageDeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type AttachmentKind = 'image' | 'video' | 'audio' | 'other';
export type Attachment = { kind: AttachmentKind; metadata?: unknown };

/** Public (Hepson) message. `id` is a Hepson UUID, never a provider id. */
export type Message = {
  id: string;
  accountId: string;
  conversationId: string;
  providerMessageId?: string;
  direction: MessageDirection;
  senderDisplayName?: string;
  text: string | null;
  attachments: Attachment[];
  sentAt: string | null;
  observedAt: string;
  deliveryStatus: MessageDeliveryStatus;
};

/** Public (Hepson) conversation. */
export type Conversation = {
  id: string;
  accountId: string;
  providerConversationId?: string;
  title: string;
  participantHandles: string[];
  latestMessageAt: string | null;
  unread: boolean | null;
};

/** What an adapter sees on the provider side. No Hepson ids. */
export type ObservedConversation = {
  providerConversationId: string;
  title: string;
  participantHandles: string[];
  latestMessageAt: string | null;
  unread: boolean | null;
};

export type ObservedMessage = {
  /** Provider id if reliably visible. */
  providerMessageId?: string;
  direction: MessageDirection;
  senderDisplayName?: string;
  text: string | null;
  attachments: Attachment[];
  /** ISO string or null when the UI timestamp is missing/ambiguous. */
  sentAt: string | null;
  /** 0-based position within the returned page, oldest first; used for fingerprinting. */
  ordinal: number;
};

export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageOpts = { limit?: number; cursor?: string };

export type SendOutcome = {
  status: Extract<MessageDeliveryStatus, 'sent' | 'uncertain' | 'failed'>;
  providerMessageId?: string;
  errorCode?: string;
};

export type AdapterCapabilities = {
  kind: AdapterKind;
  folders: { primary: boolean; general: boolean; requests: boolean };
  textMessages: boolean;
  attachmentsRead: 'placeholder' | 'full' | 'none';
  olderHistoryPaging: boolean;
  sendText: boolean;
  /** true when this adapter was exercised against a real authorized Instagram account. */
  verifiedAgainstRealProvider: boolean;
};

export type AdapterKind = 'instagram-browser' | 'instagram-official' | 'mock';

export type ConnectContext = {
  /** Expected Instagram handle for identity verification; null = learn on first connect. */
  expectedHandle: string | null;
  /** Called when the adapter learns the authenticated handle for the first time. */
  onHandleObserved?: (handle: string) => void;
  /** Open a visible window for interactive owner login if session invalid. */
  interactiveLogin: boolean;
};

export type SessionInfo = {
  /** True when the last connect succeeded from stored profile data without the owner logging in. */
  restoredFromSavedLogin: boolean;
  /** A stored login (browser profile) exists on disk. */
  hasSavedLogin: boolean;
  observedHandle: string | null;
  /** Owner is currently expected to complete login/challenge in the visible window. */
  awaitingOwner: boolean;
};

export type StatusListener = (accountId: string, status: ConnectorStatus, detail?: { code?: string; message?: string }) => void;

/**
 * Provider contract. Conversation ids here are PROVIDER ids; the service layer maps Hepson ids
 * to provider ids and checks ownership before calling the adapter.
 */
export interface MessagingAdapter {
  readonly kind: AdapterKind;
  capabilities(): AdapterCapabilities;
  onStatusChange(listener: StatusListener): void;
  connect(accountId: string, ctx: ConnectContext): Promise<ConnectorStatus>;
  getStatus(accountId: string): Promise<ConnectorStatus>;
  listConversations(accountId: string, opts?: PageOpts): Promise<Page<ObservedConversation>>;
  listMessages(accountId: string, providerConversationId: string, opts?: PageOpts): Promise<Page<ObservedMessage>>;
  /**
   * Must NOT retry internally when the outcome is unclear: return status 'uncertain'.
   * `expected.title` lets the adapter refuse to type into the wrong thread.
   */
  sendText(accountId: string, providerConversationId: string, text: string, idempotencyKey: string, expected?: { title: string }): Promise<SendOutcome>;
  sessionInfo(accountId: string): SessionInfo;
  /** Stop worker; keeps saved login. */
  disconnect(accountId: string): Promise<void>;
  /** Explicit: stop worker and delete saved login. */
  forgetSession(accountId: string): Promise<void>;
  /** Close everything (process shutdown). Keeps saved logins. */
  shutdown(): Promise<void>;
}
