import { describe, it, expect, vi } from 'vitest';
import type { Bot, h } from '@satorijs/core';
import { createQQProfile, mapQQReactionEmoji } from './qq.js';

// ── Delivery-contract tests ───────────────────────────────────────────────────
// These capture the exact content the QQ profile hands to bot.sendMessage and assert
// that agent CommonMark is flattened to plain text first. QQ renders no markdown by
// default (native markdown needs platform-approved templates this profile doesn't
// use), so `**bold**`, table pipes and `#` headings would otherwise reach the user as
// literal noise. Verifying on the pure flattener alone once let a delivery bug slip
// through, hence this captures the real send path.

const MD = '# Title\n\n**bold** and `code`, see [docs](https://x.com/a).\n\n| Name | Score |\n|------|-------|\n| Ada | 95 |';

/** Concatenate the text content of a Satori send payload (string or h[] fragment). */
function textOf(content: string | h[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((n) => (typeof n === 'string' ? n : String(n.attrs?.content ?? '')))
    .join('');
}

function fakeBot(): { bot: Bot; sent: Array<string | h[]> } {
  const sent: Array<string | h[]> = [];
  const sendMessage = vi.fn((_channelId: string, content: string | h[]) => {
    sent.push(content);
    return Promise.resolve(['qq-1']);
  });
  const bot = { sendMessage } as unknown as Bot;
  return { bot, sent };
}

describe('mapQQReactionEmoji', () => {
  it('maps known unicode emoji to the QQ `2:<char>` default-emoji form', () => {
    expect(mapQQReactionEmoji('👀')).toBe('2:👀');
    expect(mapQQReactionEmoji('✅')).toBe('2:✅');
  });

  it('returns undefined for unmapped emoji (upper layer safely skips)', () => {
    expect(mapQQReactionEmoji('🦄')).toBeUndefined();
  });
});

describe('qq profile delivery contract (text is flattened before send)', () => {
  const profile = createQQProfile();

  it('sendMessage flattens markdown: no **, no #, no raw table pipes', async () => {
    const { bot, sent } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'c1' }, MD);
    const text = textOf(sent[0]!);
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toContain('|');
    expect(text).toContain('Title');
    expect(text).toContain('docs (https://x.com/a)');
    expect(ref).toEqual({ address: { channel: 'c1' }, messageId: 'qq-1' });
  });

  it('reply flattens the body and keeps the passive/quote credentials', async () => {
    const { bot, sent } = fakeBot();
    await profile.reply!(bot, { address: { channel: 'c1' }, messageId: 'm0' }, '**hi** there');
    const fragment = sent[0] as h[];
    // First two nodes are the passive + quote control elements; the text node follows.
    const types = fragment.map((n) => (typeof n === 'string' ? 'text' : n.type));
    expect(types).toContain('passive');
    expect(types).toContain('quote');
    expect(textOf(fragment)).toBe('hi there');
  });

  it('sendButtons flattens the leading text', async () => {
    const { bot, sent } = fakeBot();
    await profile.sendButtons!(bot, { channel: 'c1' }, '**click** below', [{ id: 'b1', label: 'Yes' }]);
    expect(textOf(sent[0]!)).toContain('click below');
    expect(textOf(sent[0]!)).not.toMatch(/\*\*/);
  });
});
