import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import type { Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * Unit tests for the ConversationRegistry control surface (model override + reset).
 * Minimal stub platform/agent; verifies public-method semantics directly, no real turns.
 */

const baseConfig = {
  platforms: {
    discord: {
      type: 'discord',
      token: 't',
      chat: { channels: [], requireMention: true, freeResponseChannels: [], ignoredChannels: [], allowBots: 'none' },
    },
  },
  agents: [{ id: 'default', harness: 'custom', command: 'x', args: [], env: {} }],
  routing: { default: 'default', pipeline: [] },
  session: { scope: 'per_channel', maxPerThread: 5 },
  access: { allowFrom: [], admin: [] },
  inbound: {
    gating: { respondInDirect: true, threadParticipationExempt: true },
    reactions: { received: '👀', done: '✅', error: '❌' },
  },
  // Present because route() reads it (header bubble). The real schema defaults this in, so only
  // hand-built stubs like this one have to spell it out.
  display: { header: { enabled: false }, footer: { enabled: false, fields: [] }, reactions: { enabled: true } },
} as unknown as Config;

const stubPlatform = {
  capabilities: { thread: false },
} as unknown as PlatformAdapter;
const stubPlatforms = new Map([['discord', stubPlatform]]);

const clock = {
  now: () => 0,
  schedule: () => () => {},
};

/** A DM inbound in the one conversation these tests use. */
function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** ConversationStore stub; `cleared` records which conversations were reset by /new. */
function makeStore(cleared: string[] = []) {
  return {
    boundAgent: () => undefined,
    bind: () => {},
    agentSession: () => undefined,
    setAgentSession: () => {},
    clear: (k: string) => cleared.push(k),
  };
}

function makeFactory(): { factory: AgentFactory; disposed: string[] } {
  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async () => {},
          abort: () => {},
          dispose: () => {},
        };
        sessions.set(conversationId, s);
      }
      return s!;
    },
    dispose(sessionId) {
      disposed.push(sessionId);
      sessions.delete(sessionId);
    },
  };
  return { factory, disposed };
}

describe('ConversationRegistry control surface', () => {
  it('resetConversation calls agents.dispose to drop resume context', () => {
    const { factory, disposed } = makeFactory();
    const reg = new ConversationRegistry(baseConfig, stubPlatforms, factory, clock);
    reg.resetConversation('discord#c1');
    expect(disposed).toEqual(['discord#c1']);
  });

  it('/new (and /clear, with @bot suffix) resets context: dispose + store.delete + channel ack, no agent turn', () => {
    const { factory, disposed } = makeFactory();
    const sent: string[] = [];
    const deleted: string[] = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (address: { channel: string }, text: string) => {
        sent.push(text);
        return { address, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const store = makeStore(deleted);
    const reg = new ConversationRegistry(
      baseConfig,
      new Map([['discord', platform]]),
      factory,
      clock,
      undefined,
      store as never
    );

    for (const content of ['/new', '/clear', ' /new@mybot ']) {
      reg.route(inbound(content, `m-${content}`));
    }

    expect(disposed).toEqual(['discord#c1', 'discord#c1', 'discord#c1']);
    expect(deleted).toEqual(['discord#c1', 'discord#c1', 'discord#c1']);
    expect(sent).toHaveLength(3);
    // '/new stuff' is NOT a clear command; it must fall through to normal routing (merger created).
    expect(() => reg.route(inbound('/new stuff', 'm4'))).not.toThrow();
    expect(disposed).toHaveLength(3); // unchanged — not intercepted
  });

  it('text command routing: /codex strips the prefix and gets an agent-qualified session', () => {
    const { factory, disposed } = makeFactory();
    const sent: string[] = [];
    const deleted: string[] = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (address: { channel: string }, text: string) => {
        sent.push(text);
        return { address, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const store = makeStore(deleted);
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [
        { id: 'default', harness: 'custom', command: 'x', args: [], env: {} },
        { id: 'codex', harness: 'codex', args: [], env: {} },
      ],
      routing: { default: 'default', pipeline: [{ when: { command: 'codex' }, use: { agent: 'codex' } }] },
    } as unknown as Config;
    const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock, undefined, store as never);

    // '/codex /new' — the /codex prefix is consumed as an explicit binding, so what remains
    // ('/new') is intercepted as context clear. The key is the CONVERSATION, not the agent: a
    // reset applies to this place, whoever happens to answer it.
    reg.route(inbound('/codex /new', 'm1'));
    expect(disposed).toEqual(['discord#c1']);
    expect(deleted).toEqual(['discord#c1']);

    // A bare '/codex' (nothing to say) acks the binding instead of starting an empty turn.
    reg.route(inbound('/codex', 'm2'));
    expect(sent.some((t) => t.includes('answered by codex'))).toBe(true);
    expect(disposed).toHaveLength(1); // no extra reset — the bare command never became a turn
  });

  it('set/clearModelOverride do not throw, and clear reverts to the default', () => {
    const { factory } = makeFactory();
    const reg = new ConversationRegistry(baseConfig, stubPlatforms, factory, clock);
    expect(() => reg.setModelOverride('discord#c1', 'claude-opus-4-8')).not.toThrow();
    expect(() => reg.clearModelOverride('discord#c1')).not.toThrow();
    expect(() => reg.clearModelOverride('discord#c2')).not.toThrow(); // safe even if absent
  });
});

/**
 * The header bubble (stream.header.enabled).
 *
 * Announced once per session at RECEIPT time, before the agent runs, so it doubles as an immediate
 * "got it" while the ACP subprocess spawns. The tests that matter are the negative ones: it must not
 * repeat on every turn, and it must never fire for a message that isn't going to be answered — an
 * unconditional receipt would turn the bot into an identity/liveness oracle for unauthorized senders.
 */
describe('ConversationRegistry header bubble', () => {
  /** Config with the header on, plus a second agent whose model is only in `env` (the cc shape). */
  const headerConfig = (over?: Record<string, unknown>): Config =>
    ({
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [
        { id: 'cc', harness: 'claude', args: [], env: { ANTHROPIC_MODEL: 'opus[1m]' } },
        { id: 'oc', harness: 'opencode', model: 'anthropic/claude-opus-5', args: [], env: {} },
      ],
      routing: { default: 'cc', pipeline: [{ when: { command: 'oc' }, use: { agent: 'oc' } }] },
      display: { header: { enabled: true }, footer: { enabled: false, fields: [] }, reactions: { enabled: true } },
      ...over,
    }) as unknown as Config;

  function rig(cfg: Config) {
    const { factory } = makeFactory();
    const sent: Array<{ channelId: string; text: string }> = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (address: { channel: string }, text: string) => {
        sent.push({ channelId: address.channel, text });
        return { address, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const store = makeStore();
    const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock, undefined, store as never);
    let n = 0;
    /** `over` sets conversation-shaped fields in their flat spelling, so cases stay one-liners. */
    const send = (
      content: string,
      over: { channelId?: string; isDirect?: boolean; space?: string; userId?: string; mentionedSelf?: boolean } = {}
    ): void => {
      const { channelId = 'c1', isDirect = true, space, userId = 'u1', mentionedSelf } = over;
      reg.route({
        conversation: {
          platform: 'discord',
          channel: channelId,
          ...(space != null ? { space } : {}),
          kind: isDirect ? 'direct' : 'group',
          user: userId,
        },
        messageId: `m${++n}`,
        content,
        timestamp: 0,
        ...(mentionedSelf != null ? { mentionedSelf } : {}),
      } as never);
    };
    return { reg, sent, send };
  }

  const headers = (sent: Array<{ text: string }>): string[] =>
    sent.map((s) => s.text).filter((t) => t.startsWith('🤖'));

  it('announces the agent and its configured model on the first message', () => {
    const { sent, send } = rig(headerConfig());
    send('hello');
    // The model comes from env for this harness, so config has no `model` field to show.
    expect(headers(sent)).toEqual(['🤖 claude']);
  });

  it('never shows a model, even when the agent config carries one', () => {
    // Deliberate: at receipt time no agent session exists, so the model that will actually serve
    // the turn is unknown — and the configured value can be an outright lie (opencode ignores
    // agents[].model and runs its own default). The footer reports the real one after the fact.
    const { sent, send } = rig(headerConfig());
    send('/oc hello');
    expect(headers(sent)).toEqual(['🤖 opencode']);
  });

  it('announces only once across many turns in the same session', () => {
    const { sent, send } = rig(headerConfig());
    send('one');
    send('two');
    send('three');
    expect(headers(sent)).toEqual(['🤖 claude']);
  });

  it('announces again after /clear resets the session', () => {
    const { sent, send } = rig(headerConfig());
    send('one');
    send('/clear');
    send('two');
    expect(headers(sent)).toEqual(['🤖 claude', '🤖 claude']);
  });

  it('a /model override does not appear either (same reason)', () => {
    const { reg, sent, send } = rig(headerConfig());
    send('one'); // creates the session
    reg.setModelOverride('discord#c1', 'claude-sonnet-4-5');
    reg.resetConversation('discord#c1'); // re-arm the header without clearing the override
    send('two');
    expect(headers(sent)).toEqual(['🤖 claude', '🤖 claude']);
  });

  it('separate channels each get their own announcement', () => {
    const { sent, send } = rig(headerConfig());
    send('one');
    send('two', { channelId: 'c2' });
    expect(headers(sent)).toHaveLength(2);
    expect(sent.filter((s) => s.text.startsWith('🤖')).map((s) => s.channelId)).toEqual(['c1', 'c2']);
  });

  it('sends nothing at all when the sender is not on the allowlist', () => {
    // The security property: no header, no reaction, no reply — an unauthorized sender must not be
    // able to confirm the bot is alive or learn which agent is configured.
    const { sent, send } = rig(headerConfig({ access: { allowFrom: ['discord:someone-else'], admin: [] } }));
    send('hello');
    expect(sent).toEqual([]);
  });

  it('sends nothing when the response gate ignores the message', () => {
    // requireMention in a guild: an unmentioned message creates no turn, so it gets no header.
    const { sent, send } = rig(headerConfig());
    send('hello', { isDirect: false, space: 'g1', mentionedSelf: false });
    expect(headers(sent)).toEqual([]);
  });

  it('a bare routing command is acked but not announced (it never becomes a turn)', () => {
    const { sent, send } = rig(headerConfig());
    send('/oc');
    expect(headers(sent)).toEqual([]);
    expect(sent.some((s) => s.text.includes('answered by opencode'))).toBe(true);
  });

  it('/clear itself is acked but never announced', () => {
    const { sent, send } = rig(headerConfig());
    send('/clear');
    expect(headers(sent)).toEqual([]);
  });

  it('stays silent entirely when the header is disabled (the default)', () => {
    const { sent, send } = rig(headerConfig({ display: { header: { enabled: false }, footer: { enabled: false, fields: [] }, reactions: { enabled: true } } }));
    send('hello');
    expect(headers(sent)).toEqual([]);
  });
});

/**
 * A native slash command must produce exactly ONE turn.
 *
 * Telegram delivers `/oc hi` as two inbounds: the empty text message the client sends alongside the
 * command, and the command event itself. The empty one has no `/oc`, so routing sent it to the
 * DEFAULT agent — the user saw `🤖 claude` appear before `🤖 opencode`, and cc ran a turn nobody asked for.
 */
describe('native slash produces one turn', () => {
  function rig() {
    const { factory } = makeFactory();
    const sent: string[] = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (address: { channel: string }, text: string) => {
        sent.push(text);
        return { address, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [
        { id: 'cc', harness: 'claude', args: [], env: {} },
        { id: 'oc', harness: 'opencode', args: [], env: {} },
      ],
      routing: { default: 'cc', pipeline: [{ when: { command: 'oc' }, use: { agent: 'oc' } }] },
      display: { header: { enabled: true }, footer: { enabled: false, fields: [] }, reactions: { enabled: true } },
    } as unknown as Config;
    const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);
    // The header announcement is the observable proxy for "this agent got a turn".
    return { reg, sent };
  }

  const headers = (sent: string[]): string[] => sent.filter((t) => t.startsWith('🤖'));

  it('the phantom empty message does not announce or route to the default agent', () => {
    const { reg, sent } = rig();
    // Exactly what Telegram sends for one `/oc 你好`, in order.
    reg.route(inbound('', 'm1'));
    reg.route({ ...inbound('/oc 你好', 'm2'), mentionedSelf: true });
    // Before the fix this was ['🤖 claude', '🤖 opencode'].
    expect(headers(sent)).toEqual(['🤖 opencode']);
  });

  it('a bare /oc still gets its usage ack (the gate must not eat it)', () => {
    // `/oc` alone strips to empty content, but it is NOT an empty inbound — the user typed
    // something, so they get told how to use it rather than silence.
    const { reg, sent } = rig();
    reg.route(inbound('/oc', 'm1'));
    expect(sent.some((t) => t.includes('answered by opencode'))).toBe(true);
  });
});
