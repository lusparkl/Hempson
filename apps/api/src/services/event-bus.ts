import { EventEmitter } from 'node:events';
import type { EventType } from '@hepson/connector-core';
import type { EventRow, Store } from '@hepson/database';

export type PublicEvent = { id: string; accountId: string; sequence: number; type: EventType; occurredAt: string; payload: Record<string, unknown> };
export const toPublicEvent = (r: EventRow): PublicEvent => ({
  id: r.id,
  accountId: r.accountId,
  sequence: r.sequence,
  type: r.type as EventType,
  occurredAt: r.occurredAt,
  payload: r.payload,
});

const ALL = '*'; // account ids are UUIDs, so this cannot collide

/** Persist first, then publish. In-memory subscribers may miss events; replay via DB covers it. */
export class EventBus {
  private ee = new EventEmitter().setMaxListeners(0);
  constructor(private store: Store) {}
  emit(accountId: string, type: EventType, payload: Record<string, unknown>): PublicEvent {
    const ev = toPublicEvent(this.store.appendEvent(accountId, type, payload));
    this.ee.emit(accountId, ev);
    this.ee.emit(ALL, ev);
    return ev;
  }
  /** Every account's events (in-process consumers such as the sales agent). */
  subscribeAll(fn: (e: PublicEvent) => void): () => void {
    this.ee.on(ALL, fn);
    return () => this.ee.off(ALL, fn);
  }
  subscribe(accountId: string, fn: (e: PublicEvent) => void): () => void {
    this.ee.on(accountId, fn);
    return () => this.ee.off(accountId, fn);
  }
}
