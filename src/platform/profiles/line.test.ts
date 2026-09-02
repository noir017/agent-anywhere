import { describe, it, expect, vi } from 'vitest';
import { createLineProfile } from './line.js';
import type { Bot } from '@satorijs/core';
import type { MessageRef } from '../../types.js';

// Covers only the line profile's passive-reply no-token fallback path and the
// capability declaration. The replyToken-hit path depends on install's
// ctx.on('message') populating a non-exposed closure Map, so it's verified at the
// integration layer; here we focus on the independently testable fallback/declaration.

describe('line profile capabilities', () => {
  it('reply is true (passive reply: native reply on replyToken hit, else push fallback)', () => {
    const profile = createLineProfile();
    expect(profile.capabilities.reply).toBe(true);
    expect(typeof profile.reply).toBe('function');
  });
});

describe('line reply push fallback (no cached replyToken)', () => {
  it('token miss ⇒ falls back to bot.sendMessage, returns the first message id', async () => {
    const profile = createLineProfile();
    const ref: MessageRef = { address: { channel: 'U123' }, messageId: 'm1' };

    const sendMessage = vi.fn().mockResolvedValue(['pushed-id']);
    const replyMessage = vi.fn();
    const bot = { sendMessage, internal: { replyMessage } } as unknown as Bot;

    const out = await profile.reply!(bot, ref, 'Hello');

    // No token: skip internal.replyMessage, use push; return the push message id.
    expect(replyMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('U123', 'Hello');
    expect(out).toEqual({ address: { channel: 'U123' }, messageId: 'pushed-id' });
  });

  it('push fallback returns no id ⇒ tolerates empty string (no throw)', async () => {
    // Rationale: LINE downstream doesn't consume messageId (no edit/reaction), and
    // the replyToken-hit branch already tolerates a missing id (empty string). For
    // consistency the push fallback now tolerates empty too (no sendForRef "no id ⇒
    // throw"). The old assertion froze the previous inconsistent behavior.
    const profile = createLineProfile();
    const ref: MessageRef = { address: { channel: 'U123' }, messageId: 'm1' };
    const bot = {
      sendMessage: vi.fn().mockResolvedValue([]),
      internal: { replyMessage: vi.fn() },
    } as unknown as Bot;

    const out = await profile.reply!(bot, ref, 'x');
    expect(out).toEqual({ address: { channel: 'U123' }, messageId: '' });
  });
});

// ── Delivery-contract tests ───────────────────────────────────────────────────
// These capture the exact text string the profile hands to the adapter, asserting
// that agent CommonMark is flattened to plain text before it reaches LINE (which
// renders no markdown). A prior class of bug — flattening verified only on the pure
// converter, never on the actual delivery path — is what these guard against.
const MD = '# Title\n\n**bold** and `code`, see [docs](https://x.com/a).\n\n| Name | Score |\n|------|-------|\n| Ada | 95 |';

describe('line profile delivery contract (text is flattened before send)', () => {
  const profile = createLineProfile();

  it('sendMessage flattens markdown: no **, no #, no raw table pipes', async () => {
    const sendMessage = vi.fn().mockResolvedValue(['m-1']);
    const bot = { sendMessage, internal: { replyMessage: vi.fn() } } as unknown as Bot;

    const ref = await profile.sendMessage!(bot, { channel: 'U123' }, MD);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = String(sendMessage.mock.calls[0]![1]);
    expect(sent).not.toMatch(/\*\*/);
    expect(sent).not.toMatch(/^#/m);
    expect(sent).not.toContain('|');
    expect(sent).toContain('Title');
    expect(sent).toContain('docs (https://x.com/a)');
    expect(ref).toEqual({ address: { channel: 'U123' }, messageId: 'm-1' });
  });

  it('reply push fallback flattens markdown before pushing', async () => {
    const sendMessage = vi.fn().mockResolvedValue(['m-2']);
    const bot = { sendMessage, internal: { replyMessage: vi.fn() } } as unknown as Bot;

    await profile.reply!(bot, { address: { channel: 'U123' }, messageId: 'm0' }, '**hi** there');
    const sent = String(sendMessage.mock.calls[0]![1]);
    expect(sent).toBe('hi there');
  });
});
