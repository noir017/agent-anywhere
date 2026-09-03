import { describe, it, expect, vi } from 'vitest';
import type { Bot, h } from '@satorijs/core';
import { createWecomProfile } from './wecom.js';

// ── Delivery-contract tests ───────────────────────────────────────────────────
// WeCom app messages render no markdown — `**bold**`, table pipes and `#` headings
// would reach the user as literal noise. sendMessage is the profile's only outbound
// text path, so this captures exactly what it hands to bot.sendMessage and asserts the
// markdown was flattened to plain text first (guarding the real delivery path, not just
// the pure flattener).

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
    return Promise.resolve(['wecom-1']);
  });
  const bot = { sendMessage } as unknown as Bot;
  return { bot, sent };
}

describe('wecom profile capabilities', () => {
  it('declares a sendMessage override (the sole outbound text path)', () => {
    const profile = createWecomProfile();
    expect(typeof profile.sendMessage).toBe('function');
  });
});

describe('wecom profile delivery contract (text is flattened before send)', () => {
  const profile = createWecomProfile();

  it('sendMessage flattens markdown: no **, no #, no raw table pipes', async () => {
    const { bot, sent } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'user1' }, MD);
    const text = textOf(sent[0]!);
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toContain('|');
    expect(text).toContain('Title');
    expect(text).toContain('docs (https://x.com/a)');
    expect(ref).toEqual({ address: { channel: 'user1' }, messageId: 'wecom-1' });
  });

  it('falls back to raw text only on flattener error (graceful degradation, plain text untouched)', async () => {
    const { bot, sent } = fakeBot();
    await profile.sendMessage!(bot, { channel: 'user1' }, 'just a plain line');
    expect(textOf(sent[0]!)).toBe('just a plain line');
  });
});
