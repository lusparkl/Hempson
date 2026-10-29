import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRepository, ConversationRepository, ShopRepository, openDb, runMigrations } from '@hepson/database';
import { TelegramNotifier, renderNotification } from '../../apps/api/src/services/notifier';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hepson-notifier-'));
afterEach(() => vi.restoreAllMocks());

function setup(fetchImpl: typeof fetch, log = { warn: vi.fn() }) {
  const handle = openDb(path.join(dir, `${Math.random()}.db`));
  runMigrations(handle);
  const shops = new ShopRepository(handle);
  const agent = new AgentRepository(handle);
  const conversations = new ConversationRepository(handle);
  const shop = shops.create({ name: 'Магазин', slug: 'shop-one' });
  const { conversation } = conversations.ensureConversation(shop.id, { channel: 'mock', conversationExternalId: 't1', customer: { externalId: 't1', displayName: 'Олена', handle: null } });
  const n = new TelegramNotifier({ token: 'SECRET:TOKEN', agent, shops, conversations, log, fetchImpl, baseUrl: 'https://tg.test' });
  return { shop, agent, conversation, n, log };
}

describe('TelegramNotifier', () => {
  it('posts one plain-text message to the shop chat; the token is only in the URL', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const s = setup(f as never);
    s.agent.updateNotifySettings(s.shop.id, { telegramChatId: '-100123' });
    s.n.notify({ kind: 'escalation', shopId: s.shop.id, conversationId: s.conversation.id, reason: 'Знижка <b>30%</b>' });
    await s.n.whenIdle();
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://tg.test/botSECRET:TOKEN/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: '-100123', disable_web_page_preview: true });
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toContain('Олена');
    expect(body.text).toContain('Знижка <b>30%</b>');
  });

  it('sends nothing when the shop has no chat id', async () => {
    const f = vi.fn();
    const s = setup(f as never);
    s.n.notify({ kind: 'escalation', shopId: s.shop.id, conversationId: s.conversation.id, reason: 'x' });
    await s.n.whenIdle();
    expect(f).not.toHaveBeenCalled();
  });

  it('a failing or throwing Telegram never throws and never logs the token', async () => {
    for (const f of [vi.fn(async () => new Response('no', { status: 403 })), vi.fn(async () => Promise.reject(new TypeError('connect https://tg.test/botSECRET:TOKEN failed')))]) {
      const s = setup(f as never);
      s.agent.updateNotifySettings(s.shop.id, { telegramChatId: '1' });
      s.n.notify({ kind: 'order_draft', shopId: s.shop.id, conversationId: s.conversation.id, draftId: 'd', currency: 'UAH', totalMinor: 100, itemCount: 1 });
      await s.n.whenIdle();
      expect(s.log.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(s.log.warn.mock.calls)).not.toContain('SECRET');
    }
  });
});

describe('renderNotification', () => {
  const ctx = { shopName: 'Shop', customer: 'Олена' };
  it('is Ukrainian for uk shops and English otherwise, with the total formatted', () => {
    const n = { kind: 'order_draft', shopId: 's', conversationId: 'c', draftId: 'd', currency: 'UAH', totalMinor: 259_800, itemCount: 2 } as const;
    expect(renderNotification(n, { ...ctx, language: 'uk' })).toContain('2598.00 UAH');
    expect(renderNotification(n, { ...ctx, language: 'uk' })).toContain('Нова чернетка');
    expect(renderNotification(n, { ...ctx, language: 'en' })).toContain('order draft awaits approval');
  });
});
