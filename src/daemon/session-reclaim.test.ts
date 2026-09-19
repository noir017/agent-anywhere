import { describe, expect, it, vi } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, ReclaimState } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * Idle reclaim: stopping a conversation's resident agent child without stopping the conversation.
 *
 * What these pin is not the timer — it is the four gates. Reclaim is the daemon-restart path
 * applied to one conversation, so it is safe exactly when the next message could pick the
 * conversation back up, and the tests that matter most are the ones asserting it does NOT fire:
 * mid-turn, with a pending `ask`, on a session that cannot resume, or on one that a background job
 * is still talking to over the reverse CLI. Each of those, if it fired, would look to the user like
 * the agent silently forgetting a task it was in the middle of.
 */

const KEY: ConversationId = 'discord#c1#'; // per_thread (the default): empty trailing lane
const IDLE_MS = 30 * 60_000;

function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** Let the 1 ms merge window elapse so a routed message becomes a completed turn. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

interface RigOptions {
  /** What the stub session reports when the sweeper asks. */
  reclaimState?: ReclaimState;
  /** Turns that never settle, so the conversation is observably mid-turn. */
  hang?: boolean;
  /** The daemon's answer to "are you holding out-of-turn work for this conversation?" */
  pendingWork?: boolean;
  /** 0 disables reclaim entirely. */
  idleTimeoutMs?: number;
}

function rig(opts: RigOptions = {}) {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    session: { idleTimeoutMs: opts.idleTimeoutMs ?? IDLE_MS },
    display: { header: { enabled: false } },
  });
  const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

  // Manual `now` over real timers: the merge window still elapses (so turns actually run), while
  // the test moves the idle clock by hours without waiting for any of them.
  let t = 0;
  const clock = {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }) => ({ address, messageId: 'm' }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: opts.hang ? () => new Promise<void>(() => {}) : async () => {},
          abort: () => {},
          reclaimState: () => opts.reclaimState ?? 'resumable',
          // Note what dispose does NOT do here, mirroring both real runtimes: the handle stays in
          // the map and rebuilds its child on the next turn.
          dispose: () => void disposed.push(conversationId),
        };
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock, {
    hasPendingWork: () => opts.pendingWork ?? false,
  });

  return {
    reg,
    disposed,
    factory,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('idle reclaim', () => {
  it('stops the child of a conversation that has been quiet past the deadline', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain(); // turn ran and ended: the idle clock starts here

    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([KEY]);
  });

  it('leaves the conversation itself intact: the next message resumes the same one', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();

    // The whole promise of reclaim: the session handle (and with it the binding and the model
    // choice) survives, so the follow-up is the same conversation rather than a new one.
    const session = h.factory.peek(KEY);
    expect(session).toBeDefined();
    h.reg.route(inbound('still here?', 'm2'));
    await drain();
    expect(h.factory.peek(KEY)).toBe(session);
  });

  it('does not fire before the deadline', async () => {
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.advance(IDLE_MS - 60_000);
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([]);
  });

  it('never fires mid-turn, however long the turn has been running', async () => {
    const h = rig({ hang: true });
    h.reg.route(inbound('a task that takes hours', 'm1'));
    await drain(); // the turn is running and will not settle

    h.advance(IDLE_MS * 10);
    h.reg.reclaimIdleSessions();

    // The clock only starts when the turn ENDS, so a long task (subagents included) is never a
    // candidate. This is the gate that would otherwise kill work in flight.
    expect(h.disposed).toEqual([]);
  });

  it('never fires while the daemon holds out-of-turn work (a pending ask)', async () => {
    const h = rig({ pendingWork: true });
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.advance(IDLE_MS * 2);
    h.reg.reclaimIdleSessions();

    // From the registry's side this conversation looks idle; a CLI process is blocked on a button.
    expect(h.disposed).toEqual([]);
  });

  it('never fires on a session that cannot resume, and says so exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = rig({ reclaimState: 'unresumable' });
      h.reg.route(inbound('hello', 'm1'));
      await drain();

      h.advance(IDLE_MS * 2);
      h.reg.reclaimIdleSessions();
      h.reg.reclaimIdleSessions();
      h.reg.reclaimIdleSessions();

      expect(h.disposed).toEqual([]);
      // Explicit degradation, but once — not a warning per minute for the life of the daemon.
      const mine = warn.mock.calls.filter((c) => String(c[0]).includes('cannot resume'));
      expect(mine).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a reverse command keeps a conversation warm between turns', async () => {
    const h = rig();
    h.reg.route(inbound('start a background job', 'm1'));
    await drain();

    // Half the window passes, then the agent's background job reports in over the reverse CLI.
    h.advance(IDLE_MS - 60_000);
    h.reg.touch(KEY);
    h.advance(IDLE_MS - 60_000);
    h.reg.reclaimIdleSessions();

    // Without the touch this conversation would be well past the deadline by now.
    expect(h.disposed).toEqual([]);
  });

  it('idleTimeoutMs=0 disables reclaim entirely', async () => {
    const h = rig({ idleTimeoutMs: 0 });
    h.reg.route(inbound('hello', 'm1'));
    await drain();

    h.advance(IDLE_MS * 100);
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([]);
  });

  it('a reclaimed conversation is not reclaimed again on the next sweep', async () => {
    // After the child is gone the session reports no-child; the sweeper must read that as "nothing
    // to do" rather than logging a reclaim every minute forever.
    let state: ReclaimState = 'resumable';
    const h = rig();
    h.reg.route(inbound('hello', 'm1'));
    await drain();
    const session = h.factory.peek(KEY)!;
    (session as { reclaimState: () => ReclaimState }).reclaimState = () => state;

    h.advance(IDLE_MS + 60_000);
    h.reg.reclaimIdleSessions();
    state = 'no-child'; // what a real runtime reports once its child is down
    h.reg.reclaimIdleSessions();

    expect(h.disposed).toEqual([KEY]);
  });
});
