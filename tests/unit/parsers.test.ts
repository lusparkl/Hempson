import { describe, expect, it } from 'vitest';
import { assertIdentity, normalizeHandle, parseConversations, parseMessages, parseTimestamp, threadIdFromHref } from '@hepson/instagram-browser';

describe('parsers', () => {
  it('timestamps: ISO only, otherwise null (never invented)', () => {
    expect(parseTimestamp('2026-10-20T09:00:00Z')).toBe('2026-10-20T09:00:00.000Z');
    for (const bad of ['Вчора', '2 год', 'Yesterday 10:00', '', null, undefined, '2026-13-99T00:00']) expect(parseTimestamp(bad as never)).toBeNull();
  });
  it('thread id from href', () => {
    expect(threadIdFromHref('/direct/t/12345abc/')).toBe('12345abc');
    expect(threadIdFromHref('/direct/inbox/')).toBeNull();
    expect(threadIdFromHref('/direct/t/')).toBeNull();
  });
  it('conversations: dedupes anchors, normalizes handles, throws UI_CHANGED if nothing parses', () => {
    const r = parseConversations([
      { href: '/direct/t/aaa/', title: ' Олена  Коваль ', preview: null, datetime: null, unread: null, handles: ['@Olena.Koval'] },
      { href: '/direct/t/aaa/', title: 'Олена Коваль', preview: null, datetime: null, unread: null, handles: [] },
    ]);
    expect(r).toEqual([{ providerConversationId: 'aaa', title: 'Олена Коваль', participantHandles: ['olena.koval'], latestMessageAt: null, unread: null }]);
    expect(() => parseConversations([{ href: '/x', title: 'x', preview: null, datetime: null, unread: null, handles: [] }])).toThrowError(/No conversation row/);
    expect(parseConversations([])).toEqual([]);
  });
  it('messages: image-only => placeholder, text stays null; empty rows dropped; unknown alignment refuses', () => {
    const out = parseMessages([
      { id: null, text: null, datetime: null, align: 'left', sender: null, media: ['image'] },
      { id: 'p1', text: ' привіт ', datetime: '2026-10-20T09:00:00Z', align: 'right', sender: 'me', media: [] },
      { id: null, text: '  ', datetime: null, align: 'left', sender: null, media: [] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ direction: 'incoming', text: null, sentAt: null, attachments: [{ kind: 'image' }] });
    expect(out[1]).toMatchObject({ direction: 'outgoing', text: 'привіт', providerMessageId: 'p1' });
    expect(() => parseMessages([{ id: null, text: 'x', datetime: null, align: 'unknown', sender: null, media: [] }])).toThrowError(/direction/);
  });
  it('identity gate', () => {
    expect(assertIdentity('Shop_A', 'shop_a')).toBe('shop_a');
    expect(assertIdentity('shop_a', null)).toBe('shop_a');
    expect(() => assertIdentity('shop_b', 'shop_a')).toThrowError(/differs/);
    expect(() => assertIdentity(null, 'shop_a')).toThrowError(/Cannot confirm/);
    expect(normalizeHandle('@X.y/')).toBe('x.y');
  });
});
