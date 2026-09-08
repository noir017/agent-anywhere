import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers, FollowUpSink } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * Out-of-turn output: what the gateway does when a harness keeps talking after its turn ended.
 *
 * The bug these pin: Claude Code puts long work in the background, ends its turn ("I've started
 * it, I'll report back"), and the Agent SDK re-invokes it on its own when the work finishes.
 * claude-agent-acp forwards that continuation as ordinary `session/update` notifications with no
 * prompt in flight — and the gateway used to have no reader and no address for them, so the
 * conversation went permanently silent at the exact moment the answer arrived.
 *
 * So the interesting assertions are about the two things that were missing: a message gets rendered
 * AT ALL once the turn is over, and it gets rendered only when there is something to show.
 */

const KEY: ConversationId = 'discord#c1#'; // per_thread (the default): empty trailing lane

function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** Let the 1 ms merge window elapse, the turn run, and the render chain drain. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function rig() {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    // opencode rather than claude only so `/context` is answered locally by the gateway (on claude
    // it translates to the harness's own command and would be forwarded as a turn) — that is the
    // one observable place an out-of-turn usage snapshot shows up.
    agents: [{ id: 'oc', harness: 'opencode' }],
    routing: { default: 'oc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
  };

  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  /** Every message body the platform was asked to send, in order. */
  const sent: string[] = [];
  let seq = 0;
  const platform = {
    capabilities: { thread: false, editMessage: true, maxMessageLength: 2000 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${++seq}` };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  /** The sink TurnRunner installed on the session — the seam the ACP pump feeds. */
  let sink: FollowUpSink | undefined;
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, handlers: AgentStreamHandlers) => {
          handlers.onText('starting it in the background');
        },
        abort: () => {},
        setFollowUpSink: (s) => {
          sink = s;
        },
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);

  return {
    reg,
    sent,
    /** The installed sink, once a turn has run. */
    sink: () => {
      if (!sink) throw new Error('no follow-up sink was installed');
      return sink;
    },
  };
}

describe('follow-up rendering (background work reporting after the turn)', () => {
  it('renders output that arrives after the turn into a new message', async () => {
    const h = rig();
    h.reg.route(inbound('run the long script', 'm1'));
    await drain();
    expect(h.sent).toEqual(['starting it in the background']);

    // What the ACP pump does when the harness talks with no prompt in flight.
    const handlers = h.sink().handlers();
    handlers.onText('the script finished: 3 tests failed');
    h.sink().close();
    await drain();

    // The marker first, then the text — the two must not be able to arrive out of order, which is
    // why the marker is queued onto the render's own effects chain rather than sent directly.
    expect(h.sent).toHaveLength(3);
    expect(h.sent[1]).toContain('background update');
    expect(h.sent[2]).toBe('the script finished: 3 tests failed');
  });

  // The load-bearing negative. claude-agent-acp reports a session title after EVERY turn, so if
  // metadata opened a message, every conversation would collect an empty "background update"
  // bubble on every exchange.
  it('sends nothing when the only out-of-turn event is metadata', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;

    const handlers = h.sink().handlers();
    handlers.onTitle?.('Fix the long script');
    handlers.onUsage?.({ used: 1000, size: 200_000 });
    handlers.onModel?.('opus-4-8');
    h.sink().close();
    await drain();

    expect(h.sent).toEqual([]);
  });

  // Usage recorded out of turn still has to reach `/context`: the numbers a background continuation
  // reports are the newest ones, and they arrive nowhere near a turn.
  it('records an out-of-turn context snapshot even with nothing rendered', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.sink().handlers().onUsage?.({ used: 12_345, size: 200_000 });
    h.sink().close();

    h.reg.route(inbound('/context', 'm2'));
    await drain();
    expect(h.sent.join('\n')).toContain('12k / 200k');
  });

  // close() is called by every path that can end a burst (result, new turn, quiet timer, a child
  // going away), so it has to be safe to call twice and safe to call having rendered nothing.
  it('is idempotent and safe with nothing open', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;

    h.sink().close();
    h.sink().close();
    await drain();
    expect(h.sent).toEqual([]);
  });

  // A second burst is a second message, not a continuation of the first: handlers() resets the
  // render, so text after a close cannot land in the message that was already sealed.
  it('opens a fresh message for each burst', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.sent.length = 0;

    const first = h.sink().handlers();
    first.onText('job one done');
    h.sink().close();
    await drain();

    const second = h.sink().handlers();
    second.onText('job two done');
    h.sink().close();
    await drain();

    expect(h.sent.filter((t) => t.includes('background update'))).toHaveLength(2);
    expect(h.sent).toContain('job one done');
    expect(h.sent).toContain('job two done');
  });
});

describe('the lane survives the turn that established it', () => {
  // The reverse CLI's own version of the same bug: a background job calling
  // `agent-anywhere send-message` between turns used to be refused outright with "this conversation
  // has no active turn right now", so its whole report went nowhere.
  it('resolves a reverse-command address after the turn has ended', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    // The token the agent child was given; it is stable for the life of the conversation.
    const token = (h.reg as unknown as { tokens: { tokenFor(id: string): string } }).tokens.tokenFor(KEY);
    expect(h.reg.resolveAddress(token)).toMatchObject({ channel: 'c1' });
  });

  it('still refuses when the conversation has never run a turn', () => {
    const h = rig();
    // Route a daemon command: it creates no state and runs no turn, so there is no lane yet.
    h.reg.route(inbound('/help', 'm1'));
    expect(() => h.reg.resolveAddress('not-a-token')).toThrow(/invalid session token/);
  });
});
