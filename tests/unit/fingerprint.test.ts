import { describe, expect, it } from 'vitest';
import { fingerprintAll, messageFingerprint, type ObservedMessage } from '@hepson/connector-core';

const m = (text: string, over: Partial<ObservedMessage> = {}): ObservedMessage => ({
  direction: 'incoming',
  senderDisplayName: 'A',
  text,
  attachments: [],
  sentAt: null,
  ordinal: 0,
  ...over,
});

describe('fingerprints', () => {
  it('is stable for same snapshot and independent of position shifts', () => {
    const a = fingerprintAll('acc', 't1', [m('hi'), m('there')]);
    const b = fingerprintAll('acc', 't1', [m('older'), m('hi'), m('there')]);
    expect(b.slice(1)).toEqual(a);
  });
  it('identical consecutive texts stay distinct (occurrence index)', () => {
    const f = fingerprintAll('acc', 't1', [m('ok'), m('ok'), m('ok')]);
    expect(new Set(f).size).toBe(3);
  });
  it('collision tests: differing dims never collide', () => {
    const base = m('hello');
    const variants = [
      messageFingerprint('acc', 't1', base, 0),
      messageFingerprint('acc2', 't1', base, 0),
      messageFingerprint('acc', 't2', base, 0),
      messageFingerprint('acc', 't1', { ...base, direction: 'outgoing' }, 0),
      messageFingerprint('acc', 't1', { ...base, senderDisplayName: 'B' }, 0),
      messageFingerprint('acc', 't1', { ...base, text: 'hello!' }, 0),
      messageFingerprint('acc', 't1', { ...base, sentAt: '2026-01-01T00:00:00.000Z' }, 0),
      messageFingerprint('acc', 't1', base, 1),
      messageFingerprint('acc', 't1', { ...base, text: null, attachments: [{ kind: 'image' }] }, 0),
    ];
    expect(new Set(variants).size).toBe(variants.length);
  });
  it('whitespace/unicode normalization is equal', () => {
    expect(messageFingerprint('a', 't', m('Привіт   світ'), 0)).toBe(messageFingerprint('a', 't', m(' Привіт світ '), 0));
  });
  it('provider id wins when present', () => {
    expect(messageFingerprint('a', 't', m('x', { providerMessageId: 'p1' }), 0)).toBe(messageFingerprint('a', 't', m('y', { providerMessageId: 'p1' }), 5));
  });
});
