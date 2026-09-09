import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { withOutboundPacing } from './paced-adapter.js';
import { OutboundPacer } from '../core/outbound-pacer.js';
import { RateLimitedError } from '../core/outbound-errors.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * End-to-end for the tool-bubble flood fix, through the real wiring: ConversationRegistry →
 * TurnRunner → ToolRenderer → the paced adapter → OutboundPacer → a fake Telegram.
 *
 * The unit tests pin each piece; this pins that they are actually CONNECTED. The production bug
 * was not in any one of them — it was that the renderer wrote straight at the platform on every
 * tool event with nothing in between, so a burst of back-to-back tool calls produced two writes
 * per tool, Telegram answered 429 (`retry after` up to 229 s), and each rejected update was logged
 * as `[turn] render side effect failed:` and lost. One daemon run lost 78 that way.
 *
 * The fake platform takes ~12 ms per call ON PURPOSE. A zero-latency fake never has two events in
 * flight at once, so nothing would ever coalesce and the test would measure a situation that does
 * not exist: a real Telegram round trip is tens of milliseconds, which is exactly why a burst of
 * tool events piles up behind one write.
 */

const TOOLS = 12;
/** Roughly a Telegram round trip; the reason tool events pile up behind a write at all. */
const PLATFORM_LATENCY_MS = 12;

function inbound(content: string, messageId: string): InboundMessage {
  return {
    conversation: { platform: 'tg', channel: 'c1', kind: 'direct', user: 'u1' },
    messageId,
    content,
    timestamp: 0,
  };
}

/** Let the merge window elapse, the turn run, and every render side effect drain. */
const drain = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rig(
  opts: {
    failEditsWith?: unknown;
    failFirstNEdits?: number;
    ratePerSec?: number;
    finalizeWaitMs?: number;
  } = {}
) {
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
    display: { header: { enabled: false }, footer: { enabled: false } },
  });
  const cfg: Config = {
    ...parsed,
    inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
    // Retry fast so the test does not sit through a real backoff.
    tools: { ...parsed.tools, retryIntervalMs: 5, maxRetryMs: 5 },
    outbound: {
      ...parsed.outbound,
      // Default rate is 1/sec, which would make this test wait ~12 real seconds. The pacer's own
      // rate limiting is covered in outbound-pacer.test.ts; what is under test HERE is that the
      // renderer collapses a burst instead of writing twice per tool.
      ratePerSec: opts.ratePerSec ?? 1000,
      finalizeWaitMs: opts.finalizeWaitMs ?? 2_000,
    },
  };

  const clock = {
    now: () => Date.now(),
    schedule: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  };

  const sends: string[] = [];
  const edits: string[] = [];
  /** Every edit the platform REJECTED — the writes that used to vanish. */
  let editsRejected = 0;
  let remainingFailures = opts.failFirstNEdits ?? 0;
  let seq = 0;

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities: { thread: false, editMessage: true, maxMessageLength: 4096 },
    measureRendered: (s: string) => s.length,
    sendMessage: async (address: { channel: string }, text: string) => {
      await sleep(PLATFORM_LATENCY_MS);
      sends.push(text);
      return { address, messageId: `m${++seq}` };
    },
    editMessage: async (_ref: unknown, text: string) => {
      await sleep(PLATFORM_LATENCY_MS);
      if (remainingFailures > 0) {
        remainingFailures--;
        editsRejected++;
        throw opts.failEditsWith ?? new Error('rejected');
      }
      edits.push(text);
    },
    addReaction: async () => {},
    removeReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
  } as unknown as PlatformAdapter;

  // The real pacer and the real decorator, exactly as Daemon wires them.
  const pacer = new OutboundPacer(cfg.outbound, clock);
  const paced = withOutboundPacing(platform, pacer);

  /** Drives a run of tool calls with no text between them — the uninterrupted-tool-run shape. */
  const factory: AgentFactory = {
    getOrCreate(conversationId): AgentSession {
      return {
        conversationId,
        runTurn: async (_input, handlers: AgentStreamHandlers) => {
          handlers.onText('working on it');
          for (let i = 0; i < TOOLS; i++) {
            handlers.onToolStart({ name: 'Read', inputPreview: `file-${i}.ts`, index: i });
            handlers.onToolFinish({ name: 'Read', ok: true, durationMs: 100, index: i });
          }
          handlers.onSegmentBreak();
          handlers.onText('done');
        },
        abort: () => {},
        setFollowUpSink: () => {},
        dispose: () => {},
      };
    },
    peek: () => undefined,
    dispose: () => {},
  };

  const reg = new ConversationRegistry(cfg, new Map([['tg', paced]]), factory, clock);
  return {
    reg,
    sends,
    edits,
    rejected: () => editsRejected,
    /** Every write the platform accepted, in order. */
    all: () => [...sends, ...edits],
    /** Writes that actually reached the platform. */
    writeCount: () => sends.length + edits.length,
  };
}

describe('a run of back-to-back tool calls does not flood the chat', () => {
  it('collapses 24 tool events into far fewer writes', async () => {
    const h = rig();
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(600);

    // 12 tools × (start + finish) = 24 events. Each used to be its own write into one chat.
    expect(h.writeCount()).toBeLessThan(TOOLS);
  });

  it('collapsing loses nothing: every tool ends up on screen, finished', async () => {
    const h = rig();
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(600);

    const bubble = h.all().find((t) => t.includes(`file-${TOOLS - 1}.ts`));
    expect(bubble).toBeDefined();
    expect(bubble!.split('\n').filter((l) => l.includes('✓'))).toHaveLength(TOOLS);
  });

  it('the reply still arrives, after the tool bubble', async () => {
    const h = rig();
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(600);

    expect(h.sends[0]).toBe('working on it');
    expect(h.sends[h.sends.length - 1]).toBe('done');
  });

  it('the pacer caps how much can go out at once, whatever the renderer asks for', async () => {
    // Production settings: 1 write/sec sustained. Nothing beyond the burst may reach the platform
    // in the first moments, however many events the agent produces.
    const h = rig({ ratePerSec: 1 });
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(600);

    expect(h.writeCount()).toBeLessThanOrEqual(12); // outbound.burst
  });
});

describe('a 429 mid-run costs no progress and does not stall the turn', () => {
  it('regression: the rejected update comes back on the retry instead of vanishing', async () => {
    // The exact failure from the logs: Telegram rejects the edit with a stated wait.
    const h = rig({
      failFirstNEdits: 1,
      failEditsWith: new RateLimitedError('Too Many Requests: retry after 1', { retryAfterMs: 5 }),
    });
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(600);

    expect(h.rejected()).toBe(1); // the platform really did refuse a write
    // ...and the progress it refused is on screen anyway. Before this change that write was
    // rethrown into the render chain, logged as "render side effect failed", and never retried.
    const bubble = h.all().find((t) => t.includes(`file-${TOOLS - 1}.ts`));
    expect(bubble).toBeDefined();
    expect(bubble!.split('\n').filter((l) => l.includes('✓'))).toHaveLength(TOOLS);
  });

  it('the turn still completes and still delivers its reply', async () => {
    const h = rig({
      failFirstNEdits: 3,
      failEditsWith: new RateLimitedError('flood', { retryAfterMs: 5 }),
    });
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(600);

    // The reply is not held hostage by a bubble the platform is refusing.
    expect(h.sends).toContain('done');
  });
});

describe('a finished turn stops writing', () => {
  it('does not leave a retry loop running after the turn is over', async () => {
    // The lane never recovers. The turn must still end, AND the renderer must stop trying —
    // an armed retry keeps the render alive on a timer, so a leaked one would repaint a
    // finished turn's bubble for the life of the process.
    const h = rig({
      failFirstNEdits: Number.MAX_SAFE_INTEGER,
      failEditsWith: new RateLimitedError('flood', { retryAfterMs: 5 }),
      finalizeWaitMs: 30,
    });
    h.reg.route(inbound('do the thing', 'm1'));
    await drain(400);

    expect(h.sends).toContain('done'); // the turn finished despite the dead lane
    const attemptsAtTurnEnd = h.rejected();
    await drain(300);
    expect(h.rejected()).toBe(attemptsAtTurnEnd); // ...and nothing is still retrying
  });
});
