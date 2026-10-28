export type Acc = {
  accountId: string;
  label: string;
  connectorType: 'mock' | 'instagram-browser';
  dataSource: string;
  status: string;
  statusMessage: string;
  enabled: boolean;
  paused: boolean;
  outboundEnabled: boolean;
  expectedInstagramHandle: string | null;
  lastAuthValidatedAt: string | null;
  lastErrorCode: string | null;
  restoredFromSavedLogin: boolean;
  hasSavedLogin: boolean;
  awaitingOwnerAction: boolean;
  lastSyncAt: string | null;
};
export type Conv = { id: string; title: string; participantHandles: string[]; latestMessageAt: string | null; unread: boolean | null; providerConversationId?: string };
export type Msg = {
  id: string;
  direction: 'incoming' | 'outgoing';
  text: string | null;
  attachments: Array<{ kind: string }>;
  sentAt: string | null;
  observedAt: string;
  deliveryStatus: string;
};
export type Ev = { id: string; sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> };
export type Outbox = { outboxId: string; status: string; errorCode: string | null; needsReview: boolean; body: string; createdAt: string };

export class ApiError extends Error {
  constructor(
    public code: string,
    m: string,
  ) {
    super(m);
  }
}

export function client(key: string) {
  const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(j?.error?.code ?? 'ERROR', j?.error?.message ?? r.statusText);
    return j as T;
  }
  /** SSE over fetch (EventSource cannot send the Authorization header). Resumes from last sequence. */
  function stream(accountId: string, after: number, onEvent: (e: Ev) => void, signal: AbortSignal) {
    (async () => {
      let last = after;
      while (!signal.aborted) {
        try {
          const r = await fetch(`/v1/accounts/${accountId}/events/stream?afterSequence=${last}`, { headers: h, signal });
          const reader = r.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = chunk.split('\n').find((l) => l.startsWith('data: '));
              if (data) {
                const ev = JSON.parse(data.slice(6)) as Ev;
                last = Math.max(last, ev.sequence);
                onEvent(ev);
              }
            }
          }
        } catch {
          /* reconnect */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
  }
  return { req, stream };
}
