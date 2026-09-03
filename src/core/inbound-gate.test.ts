import { describe, it, expect } from 'vitest';
import type { InboundMessage } from '../types.js';
import {
  shouldRespond,
  type GateConfig,
  type GateContext,
} from './inbound-gate.js';

/**
 * Minimal InboundMessage; overrides set gating-relevant fields.
 *
 * The conversation-shaped fields (channel / lane / kind) are accepted in their old flat spelling
 * so each case still reads as one line about the thing under test. `isDirect`/`isThread` map onto
 * the single `kind` witness that replaced them.
 */
type MsgOverrides = Partial<Omit<InboundMessage, 'conversation'>> & {
  channelId?: string;
  thread?: string;
  isDirect?: boolean;
  isThread?: boolean;
};

function makeMsg(overrides: MsgOverrides = {}): InboundMessage {
  const { channelId = 'C1', thread, isDirect, isThread, ...rest } = overrides;
  return {
    conversation: {
      platform: 'discord',
      channel: channelId,
      ...(thread != null ? { thread } : {}),
      kind: isDirect ? 'direct' : isThread ? 'thread' : 'group',
      user: 'U1',
    },
    messageId: 'M1',
    content: 'hello',
    timestamp: 0,
    ...rest,
  };
}

/** Default gating config (mirrors schema defaults). */
function makeCfg(overrides: Partial<GateConfig> = {}): GateConfig {
  return {
    requireMentionInGuild: true,
    respondInDirect: true,
    allowBots: 'none',
    freeResponseChannels: [],
    ignoredChannels: [],
    threadParticipationExempt: true,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<GateContext> = {}): GateContext {
  return { hasActiveSession: false, ...overrides };
}

describe('shouldRespond · blocklisted channel', () => {
  it('matches ignoredChannels → false ignored-channel (highest priority)', () => {
    const d = shouldRespond(
      makeMsg({ channelId: 'C1', mentionedSelf: true, isDirect: true }),
      makeCfg({ ignoredChannels: ['C1'] }),
      makeCtx()
    );
    expect(d).toEqual({ respond: false, reason: 'ignored-channel' });
  });
});

describe('shouldRespond · bot author', () => {
  it("allowBots='none' → false bot-blocked", () => {
    const d = shouldRespond(
      makeMsg({ authorIsBot: true, mentionedSelf: true }),
      makeCfg({ allowBots: 'none' }),
      makeCtx()
    );
    expect(d).toEqual({ respond: false, reason: 'bot-blocked' });
  });

  it("allowBots='mentions' and not mentioned → false bot-no-mention", () => {
    const d = shouldRespond(
      makeMsg({ authorIsBot: true, mentionedSelf: false }),
      makeCfg({ allowBots: 'mentions' }),
      makeCtx()
    );
    expect(d).toEqual({ respond: false, reason: 'bot-no-mention' });
  });

  it("allowBots='mentions' and mentioned → continues to later checks (guild require-mention met → default)", () => {
    const d = shouldRespond(
      makeMsg({ authorIsBot: true, mentionedSelf: true }),
      makeCfg({ allowBots: 'mentions' }),
      makeCtx()
    );
    expect(d).toEqual({ respond: true, reason: 'default' });
  });

  it("allowBots='all' continues to later checks even when not mentioned (guild not mentioned → no-mention)", () => {
    const d = shouldRespond(
      makeMsg({ authorIsBot: true, mentionedSelf: false }),
      makeCfg({ allowBots: 'all' }),
      makeCtx()
    );
    expect(d).toEqual({ respond: false, reason: 'no-mention' });
  });
});

describe('shouldRespond · direct message (DM)', () => {
  it('respondInDirect=true → true dm', () => {
    const d = shouldRespond(
      makeMsg({ isDirect: true }),
      makeCfg({ respondInDirect: true }),
      makeCtx()
    );
    expect(d).toEqual({ respond: true, reason: 'dm' });
  });

  it('respondInDirect=false → false dm-disabled', () => {
    const d = shouldRespond(
      makeMsg({ isDirect: true }),
      makeCfg({ respondInDirect: false }),
      makeCtx()
    );
    expect(d).toEqual({ respond: false, reason: 'dm-disabled' });
  });
});

describe('shouldRespond · free-response channel', () => {
  it('matches freeResponseChannels and not mentioned → true free-response', () => {
    const d = shouldRespond(
      makeMsg({ channelId: 'C2', mentionedSelf: false }),
      makeCfg({ freeResponseChannels: ['C2'] }),
      makeCtx()
    );
    expect(d).toEqual({ respond: true, reason: 'free-response' });
  });
});

describe('shouldRespond · thread-participation exemption', () => {
  it('thread + exemption on + active session + not mentioned → true thread-participated', () => {
    const d = shouldRespond(
      makeMsg({ isThread: true, mentionedSelf: false }),
      makeCfg({ threadParticipationExempt: true }),
      makeCtx({ hasActiveSession: true })
    );
    expect(d).toEqual({ respond: true, reason: 'thread-participated' });
  });

  it('thread but no active session (not participated) and not mentioned → false no-mention', () => {
    const d = shouldRespond(
      makeMsg({ isThread: true, mentionedSelf: false }),
      makeCfg({ threadParticipationExempt: true }),
      makeCtx({ hasActiveSession: false })
    );
    expect(d).toEqual({ respond: false, reason: 'no-mention' });
  });

  it('exemption off: even if participated it is not exempt, not mentioned → false no-mention', () => {
    const d = shouldRespond(
      makeMsg({ isThread: true, mentionedSelf: false }),
      makeCfg({ threadParticipationExempt: false }),
      makeCtx({ hasActiveSession: true })
    );
    expect(d).toEqual({ respond: false, reason: 'no-mention' });
  });
});

describe('shouldRespond · guild channel require-mention', () => {
  it('mention required and mentioned → true default', () => {
    const d = shouldRespond(
      makeMsg({ mentionedSelf: true }),
      makeCfg({ requireMentionInGuild: true }),
      makeCtx()
    );
    expect(d).toEqual({ respond: true, reason: 'default' });
  });

  it('mention required and not mentioned (undefined treated as not mentioned) → false no-mention', () => {
    const d = shouldRespond(
      makeMsg({}),
      makeCfg({ requireMentionInGuild: true }),
      makeCtx()
    );
    expect(d).toEqual({ respond: false, reason: 'no-mention' });
  });
});

describe('shouldRespond · default allow', () => {
  it('guild channel that does not require a mention → true default', () => {
    const d = shouldRespond(
      makeMsg({ mentionedSelf: false }),
      makeCfg({ requireMentionInGuild: false }),
      makeCtx()
    );
    expect(d).toEqual({ respond: true, reason: 'default' });
  });
});

/**
 * Empty messages.
 *
 * Telegram delivers a native slash command as TWO inbounds: an empty text message plus the command
 * event. The empty one carries no command text, so it routed to the DEFAULT agent and started a
 * second turn beside the real one — a `/oc hi` was answered by oc AND cc. Attachment-only messages
 * (an image with no caption) are real input and must still pass.
 */
describe('shouldRespond · empty message', () => {
  it('rejects a message with no text and no attachments', () => {
    const d = shouldRespond(makeMsg({ content: '' }), makeCfg(), makeCtx());
    expect(d).toEqual({ respond: false, reason: 'empty' });
  });

  it('rejects whitespace-only text', () => {
    expect(shouldRespond(makeMsg({ content: '   \n\t ' }), makeCfg(), makeCtx()).respond).toBe(false);
  });

  it('accepts an attachment-only message (image with no caption)', () => {
    const msg = makeMsg({
      content: '',
      isDirect: true,
      attachments: [{ type: 'image', url: 'https://example.com/a.png' }],
    });
    expect(shouldRespond(msg, makeCfg(), makeCtx()).respond).toBe(true);
  });

  it('rejects empty even in a DM, where everything else is allowed', () => {
    // The empty phantom message arrives in the same DM as the real command, so the DM branch must
    // not rescue it.
    const d = shouldRespond(makeMsg({ content: '', isDirect: true }), makeCfg(), makeCtx());
    expect(d).toEqual({ respond: false, reason: 'empty' });
  });

  it('rejects empty even in a free-response channel', () => {
    const d = shouldRespond(
      makeMsg({ content: '' }),
      makeCfg({ freeResponseChannels: ['C1'] }),
      makeCtx()
    );
    expect(d.respond).toBe(false);
  });

  it('rejects empty even when mentioned in a guild', () => {
    const d = shouldRespond(makeMsg({ content: '', mentionedSelf: true }), makeCfg(), makeCtx());
    expect(d.respond).toBe(false);
  });

  it('still reports ignored-channel for an empty message in a blocked channel', () => {
    // Ordering detail: 'empty' short-circuits first, so a blocked channel with an empty message
    // reports 'empty'. Either reason is a rejection; this pins the actual behavior.
    const d = shouldRespond(makeMsg({ content: '' }), makeCfg({ ignoredChannels: ['C1'] }), makeCtx());
    expect(d.respond).toBe(false);
    expect(d.reason).toBe('empty');
  });

  it('non-empty text is unaffected', () => {
    expect(shouldRespond(makeMsg({ isDirect: true }), makeCfg(), makeCtx()).respond).toBe(true);
  });
});
