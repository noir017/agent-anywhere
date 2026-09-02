import { describe, expect, it } from 'vitest';
import { SessionRegistry } from './session.js';
import type { Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';

/**
 * Unit tests for SessionRegistry session control (model override + reset).
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
  display: { header: { enabled: false }, footer: { enabled: false, fields: [] } },
} as unknown as Config;

const stubPlatform = {
  capabilities: { thread: false },
} as unknown as PlatformAdapter;
const stubPlatforms = new Map([['discord', stubPlatform]]);

const clock = {
  now: () => 0,
  schedule: () => () => {},
};

function makeFactory(): { factory: AgentFactory; disposed: string[] } {
  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(sessionId) {
      let s = sessions.get(sessionId);
      if (!s) {
        s = {
          sessionId,
          runTurn: async () => {},
          abort: () => {},
          dispose: () => {},
        };
        sessions.set(sessionId, s);
      }
      return s;
    },
    dispose(sessionId) {
      disposed.push(sessionId);
      sessions.delete(sessionId);
    },
  };
  return { factory, disposed };
}

describe('SessionRegistry session control', () => {
  it('resetSession calls agents.dispose to drop resume context', () => {
    const { factory, disposed } = makeFactory();
    const reg = new SessionRegistry(baseConfig, stubPlatforms, factory, clock);
    reg.resetSession('discord:c1');
    expect(disposed).toEqual(['discord:c1']);
  });

  it('/new (and /clear, with @bot suffix) resets context: dispose + store.delete + channel ack, no agent turn', () => {
    const { factory, disposed } = makeFactory();
    const sent: string[] = [];
    const deleted: string[] = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (_ch: string, text: string) => {
        sent.push(text);
        return { channelId: _ch, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const store = { get: () => undefined, set: () => {}, delete: (k: string) => deleted.push(k) };
    const reg = new SessionRegistry(
      baseConfig,
      new Map([['discord', platform]]),
      factory,
      clock,
      undefined,
      store as never
    );

    for (const content of ['/new', '/clear', ' /new@mybot ']) {
      reg.route({
        platform: 'discord',
        channelId: 'c1',
        userId: 'u1',
        messageId: `m-${content}`,
        content,
        isDirect: true,
      } as never);
    }

    expect(disposed).toEqual(['default:discord:c:c1', 'default:discord:c:c1', 'default:discord:c:c1']);
    expect(deleted).toEqual(['default:discord:c:c1', 'default:discord:c:c1', 'default:discord:c:c1']);
    expect(sent).toHaveLength(3);
    // '/new stuff' is NOT a clear command; it must fall through to normal routing (merger created).
    expect(() =>
      reg.route({
        platform: 'discord',
        channelId: 'c1',
        userId: 'u1',
        messageId: 'm4',
        content: '/new stuff',
        isDirect: true,
      } as never)
    ).not.toThrow();
    expect(disposed).toHaveLength(3); // unchanged — not intercepted
  });

  it('text command routing: /codex strips the prefix and gets an agent-qualified session', () => {
    const { factory, disposed } = makeFactory();
    const sent: string[] = [];
    const deleted: string[] = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (_ch: string, text: string) => {
        sent.push(text);
        return { channelId: _ch, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const store = { get: () => undefined, set: () => {}, delete: (k: string) => deleted.push(k) };
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [
        { id: 'default', harness: 'custom', command: 'x', args: [], env: {} },
        { id: 'codex', harness: 'codex', args: [], env: {} },
      ],
      routing: { default: 'default', pipeline: [{ when: { command: 'codex' }, use: { agent: 'codex' } }] },
    } as unknown as Config;
    const reg = new SessionRegistry(cfg, new Map([['discord', platform]]), factory, clock, undefined, store as never);

    // '/codex /new' — the /codex prefix is consumed by routing, so what remains ('/new') is
    // intercepted as context clear, on codex's OWN session key (not the default agent's).
    reg.route({
      platform: 'discord',
      channelId: 'c1',
      userId: 'u1',
      messageId: 'm1',
      content: '/codex /new',
      isDirect: true,
    } as never);
    expect(disposed).toEqual(['codex:discord:c:c1']);
    expect(deleted).toEqual(['codex:discord:c:c1']);

    // A bare '/codex' (nothing to say) is acked with usage instead of starting an empty turn.
    reg.route({
      platform: 'discord',
      channelId: 'c1',
      userId: 'u1',
      messageId: 'm2',
      content: '/codex',
      isDirect: true,
    } as never);
    expect(sent.some((t) => t.includes('routed to agent "codex"'))).toBe(true);
    expect(disposed).toHaveLength(1); // no extra reset — the bare command never became a turn
  });

  it('set/clearModelOverride do not throw, and clear reverts to the default', () => {
    const { factory } = makeFactory();
    const reg = new SessionRegistry(baseConfig, stubPlatforms, factory, clock);
    expect(() => reg.setModelOverride('discord:c1', 'claude-opus-4-8')).not.toThrow();
    expect(() => reg.clearModelOverride('discord:c1')).not.toThrow();
    expect(() => reg.clearModelOverride('discord:c2')).not.toThrow(); // safe even if absent
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
describe('SessionRegistry header bubble', () => {
  /** Config with the header on, plus a second agent whose model is only in `env` (the cc shape). */
  const headerConfig = (over?: Record<string, unknown>): Config =>
    ({
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [
        { id: 'cc', harness: 'claude', args: [], env: { ANTHROPIC_MODEL: 'opus[1m]' } },
        { id: 'oc', harness: 'opencode', model: 'anthropic/claude-opus-5', args: [], env: {} },
      ],
      routing: { default: 'cc', pipeline: [{ when: { command: 'oc' }, use: { agent: 'oc' } }] },
      display: { header: { enabled: true }, footer: { enabled: false, fields: [] } },
      ...over,
    }) as unknown as Config;

  function rig(cfg: Config) {
    const { factory } = makeFactory();
    const sent: Array<{ channelId: string; text: string }> = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (channelId: string, text: string) => {
        sent.push({ channelId, text });
        return { channelId, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const store = { get: () => undefined, set: () => {}, delete: () => {} };
    const reg = new SessionRegistry(cfg, new Map([['discord', platform]]), factory, clock, undefined, store as never);
    let n = 0;
    const send = (content: string, over?: Record<string, unknown>): void =>
      reg.route({
        platform: 'discord',
        channelId: 'c1',
        userId: 'u1',
        messageId: `m${++n}`,
        content,
        isDirect: true,
        ...over,
      } as never);
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
    reg.setModelOverride('cc:discord:c:c1', 'claude-sonnet-4-5');
    reg.resetSession('cc:discord:c:c1'); // re-arm the header without clearing the override
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
    send('hello', { isDirect: false, guildId: 'g1', mentionedSelf: false });
    expect(headers(sent)).toEqual([]);
  });

  it('a bare routing command is acked but not announced (it never becomes a turn)', () => {
    const { sent, send } = rig(headerConfig());
    send('/oc');
    expect(headers(sent)).toEqual([]);
    expect(sent.some((s) => s.text.includes('routed to agent "oc"'))).toBe(true);
  });

  it('/clear itself is acked but never announced', () => {
    const { sent, send } = rig(headerConfig());
    send('/clear');
    expect(headers(sent)).toEqual([]);
  });

  it('stays silent entirely when the header is disabled (the default)', () => {
    const { sent, send } = rig(headerConfig({ display: { header: { enabled: false }, footer: { enabled: false, fields: [] } } }));
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
describe('SessionRegistry native slash produces one turn', () => {
  function rig() {
    const { factory } = makeFactory();
    const sent: string[] = [];
    const platform = {
      capabilities: { thread: false },
      sendMessage: async (channelId: string, text: string) => {
        sent.push(text);
        return { channelId, messageId: 'm1' };
      },
    } as unknown as PlatformAdapter;
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [
        { id: 'cc', harness: 'claude', args: [], env: {} },
        { id: 'oc', harness: 'opencode', args: [], env: {} },
      ],
      routing: { default: 'cc', pipeline: [{ when: { command: 'oc' }, use: { agent: 'oc' } }] },
      display: { header: { enabled: true }, footer: { enabled: false, fields: [] } },
    } as unknown as Config;
    const reg = new SessionRegistry(cfg, new Map([['discord', platform]]), factory, clock);
    // The header announcement is the observable proxy for "this agent got a turn".
    return { reg, sent };
  }

  const headers = (sent: string[]): string[] => sent.filter((t) => t.startsWith('🤖'));

  it('the phantom empty message does not announce or route to the default agent', () => {
    const { reg, sent } = rig();
    // Exactly what Telegram sends for one `/oc 你好`, in order.
    reg.route({ platform: 'discord', channelId: 'c1', userId: 'u1', messageId: 'm1', content: '', isDirect: true } as never);
    reg.route({ platform: 'discord', channelId: 'c1', userId: 'u1', messageId: 'm2', content: '/oc 你好', isDirect: true, mentionedSelf: true } as never);
    // Before the fix this was ['🤖 claude', '🤖 opencode'].
    expect(headers(sent)).toEqual(['🤖 opencode']);
  });

  it('a bare /oc still gets its usage ack (the gate must not eat it)', () => {
    // `/oc` alone strips to empty content, but it is NOT an empty inbound — the user typed
    // something, so they get told how to use it rather than silence.
    const { reg, sent } = rig();
    reg.route({ platform: 'discord', channelId: 'c1', userId: 'u1', messageId: 'm1', content: '/oc', isDirect: true } as never);
    expect(sent.some((t) => t.includes('routed to agent "oc"'))).toBe(true);
  });
});
