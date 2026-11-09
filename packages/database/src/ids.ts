import { randomBytes } from 'node:crypto';

let lastMs = 0;
let counter = 0;

/**
 * UUIDv7 that sorts by creation order within this process, even inside one millisecond (4096 per ms, then it borrows
 * from the next ms). Append-only tables use it as the tie-break after `created_at`, so no table depends on SQLite's implicit row order.
 */
export function orderedId(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = 0;
  } else if (++counter > 0xfff) {
    lastMs += 1;
    counter = 0;
  }
  const ms = lastMs.toString(16).padStart(12, '0');
  const rand = randomBytes(8);
  rand[0] = (rand[0]! & 0x3f) | 0x80;
  const tail = rand.toString('hex');
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${counter.toString(16).padStart(3, '0')}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}
