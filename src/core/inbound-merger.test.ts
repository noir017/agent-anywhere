import { describe, expect, it, vi } from 'vitest';
import { InboundMerger, type MergerDeps } from './inbound-merger.js';
import type { InboundMessage } from '../types.js';

/**
 * Unit tests for the interrupt path (interruptOnNewMessage): a message arriving while a turn runs
 * cancels the in-flight turn (abortTurn + trips the turn's AbortSignal) and runs the queued message
 * as a fresh batch; with the flag off, the message is queued and waits for the natural turn end.
 */

function msg(id: string): InboundMessage {
  return {
    conversation: { platform: 'discord', channel: 'c', kind: 'group', user: 'u' },
    messageId: id,
    content: id,
    timestamp: 0,
  };
}

const reactions = { received: '👀', done: '✅', error: '❌' };

/** Minimal manual scheduler: schedule() records timers; advance() fires those past due. */
function makeClock() {
  let t = 0;
  const timers: Array<{ fn: () => void; at: number }> = [];
  return {
    now: () => t,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: t + ms };
      timers.push(entry);
      return () => {
        const i = timers.indexOf(entry);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    advance(ms: number) {
      t += ms;
      for (const e of timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)) {
        const i = timers.indexOf(e);
        if (i >= 0) timers.splice(i, 1);
        e.fn();
      }
    },
  };
}

/** Flush pending microtasks/macrotasks (real timers, separate from the mocked clock). */
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(interruptOnNewMessage: boolean) {
  const clock = makeClock();
  const batches: string[][] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let resolveFirst!: () => void;
  let n = 0;
  const abortTurn = vi.fn();
  const deps: MergerDeps = {
    now: clock.now,
    schedule: clock.schedule,
    addReaction: vi.fn().mockResolvedValue(undefined),
    runTurn: vi.fn((batch: InboundMessage[], signal?: AbortSignal) => {
      batches.push(batch.map((m) => m.messageId));
      signals.push(signal);
      n += 1;
      // First turn stays pending until the test resolves it (so a second message lands mid-run).
      if (n === 1) return new Promise<void>((res) => (resolveFirst = res));
      return Promise.resolve();
    }),
    abortTurn,
  };
  const merger = new InboundMerger(
    { mergeWindowMs: 1500, maxMergeWindowMs: 5000, interruptOnNewMessage, reactions },
    deps
  );
  return { merger, clock, deps, batches, signals, abortTurn, resolveFirst: () => resolveFirst() };
}

describe('InboundMerger interrupt', () => {
  it('interruptOnNewMessage=true: aborts the running turn and runs the new message as a fresh batch', async () => {
    const h = harness(true);

    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500); // merge window elapses → first turn dispatched (stays pending)
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    expect(h.merger.isIdle()).toBe(false);

    // New message during the running turn → cancel the agent + trip the turn's abort signal.
    await h.merger.ingest(msg('m2'));
    expect(h.abortTurn).toHaveBeenCalledTimes(1);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1); // not yet — waits for the interrupted turn to settle

    // Interrupted turn settles → queued m2 runs as a fresh, un-aborted batch.
    h.resolveFirst();
    await tick();
    expect(h.deps.runTurn).toHaveBeenCalledTimes(2);
    expect(h.batches[1]).toEqual(['m2']);
    expect(h.signals[1]?.aborted).toBe(false);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('interruptOnNewMessage=false: queues the new message and waits for the natural turn end', async () => {
    const h = harness(false);

    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);

    await h.merger.ingest(msg('m2'));
    expect(h.abortTurn).not.toHaveBeenCalled();
    expect(h.signals[0]?.aborted).toBe(false);
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);

    h.resolveFirst();
    await tick();
    expect(h.deps.runTurn).toHaveBeenCalledTimes(2);
    expect(h.batches[1]).toEqual(['m2']);
  });
});

/**
 * Lifecycle reactions (display.reactions.enabled).
 *
 * The emoji land on the USER's own message — 👀 while the turn runs, then ✅/❌ (Telegram maps those
 * into its allow-set as 👌/👎). In a single-operator DM that is pure noise: the reply itself already
 * proves the message was seen. Turning it off must suppress every one of the three, and must not
 * disturb the turn itself.
 */
describe('InboundMerger lifecycle reactions', () => {
  /** Harness with turns that settle immediately, so both the received and done paths are observable. */
  function reactionHarness(reactionsEnabled: boolean | undefined, failTurn = false) {
    const clock = makeClock();
    const reacted: string[] = [];
    const deps: MergerDeps = {
      now: clock.now,
      schedule: clock.schedule,
      addReaction: vi.fn(async (_ref, emoji: string) => void reacted.push(emoji)),
      runTurn: vi.fn(() => (failTurn ? Promise.reject(new Error('boom')) : Promise.resolve())),
    };
    const merger = new InboundMerger(
      {
        mergeWindowMs: 1500,
        maxMergeWindowMs: 5000,
        interruptOnNewMessage: true,
        reactions,
        ...(reactionsEnabled === undefined ? {} : { reactionsEnabled }),
      },
      deps
    );
    return { merger, clock, deps, reacted };
  }

  it('enabled: marks the message 👀 on receipt and ✅ when the turn completes', async () => {
    const h = reactionHarness(true);
    await h.merger.ingest(msg('m1'));
    expect(h.reacted).toEqual(['👀']);
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual(['👀', '✅']);
  });

  it('disabled: sends no reaction at all, and the turn still runs', async () => {
    const h = reactionHarness(false);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    // The actual bug being fixed: the user's message must come back unmarked.
    expect(h.deps.addReaction).not.toHaveBeenCalled();
    expect(h.reacted).toEqual([]);
    // Suppressing the decoration must not suppress the work.
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('disabled: a FAILED turn is also left unmarked (no ❌ either)', async () => {
    // ❌ goes through the same choke point. Losing it costs no information: turn-runner sends a
    // readable "this turn failed" message in-channel regardless.
    const h = reactionHarness(false, true);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual([]);
    expect(h.merger.isIdle()).toBe(true);
  });

  it('enabled: a failed turn is marked ❌', async () => {
    const h = reactionHarness(true, true);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual(['👀', '❌']);
  });

  it('omitted: defaults to reacting, so an old caller keeps the previous behavior', async () => {
    const h = reactionHarness(undefined);
    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500);
    await tick();
    expect(h.reacted).toEqual(['👀', '✅']);
  });
});

/**
 * Explicit interrupt (`/stop`).
 *
 * Two properties matter and neither is covered above. It must work with interruptOnNewMessage OFF —
 * that flag governs the implicit path, and a user who typed "stop" is not asking for its opinion —
 * and it must drop the queued backlog, or "stop" would mean "stop, then immediately start the next
 * thing", which is how a stop command earns a reputation for not stopping anything.
 */
describe('InboundMerger.interrupt (/stop)', () => {
  const emojis = (h: ReturnType<typeof harness>) =>
    vi.mocked(h.deps.addReaction).mock.calls.map((c) => c[1]);

  it('running: cancels the turn, drops the backlog, and marks no ✅ — with the implicit flag off', async () => {
    const h = harness(false); // interruptOnNewMessage=false: /stop must not depend on it

    await h.merger.ingest(msg('m1'));
    h.clock.advance(1500); // turn dispatched, stays pending
    await h.merger.ingest(msg('m2')); // queued behind it (no implicit interrupt)
    expect(h.abortTurn).not.toHaveBeenCalled();

    expect(h.merger.interrupt()).toBe('running');
    expect(h.abortTurn).toHaveBeenCalledTimes(1);
    expect(h.signals[0]?.aborted).toBe(true);

    h.resolveFirst();
    await tick();
    // The backlog is gone rather than promoted to the next turn.
    expect(h.deps.runTurn).toHaveBeenCalledTimes(1);
    expect(h.merger.isIdle()).toBe(true);
    // 👀 for each of the two messages, and no ✅: the turn was stopped, not completed.
    expect(emojis(h)).toEqual(['👀', '👀']);
  });

  it('collecting: drops the batch before it ever reaches the agent', async () => {
    const h = harness(false);

    await h.merger.ingest(msg('m1')); // inside the merge window, nothing dispatched yet
    expect(h.merger.interrupt()).toBe('collecting');

    h.clock.advance(5000); // the window would have elapsed long ago
    await tick();
    expect(h.deps.runTurn).not.toHaveBeenCalled();
    expect(h.abortTurn).not.toHaveBeenCalled(); // there was no turn to abort
    expect(h.merger.isIdle()).toBe(true);
  });

  it('idle: reports idle and touches nothing', async () => {
    const h = harness(false);
    expect(h.merger.interrupt()).toBe('idle');
    expect(h.abortTurn).not.toHaveBeenCalled();
    expect(h.deps.runTurn).not.toHaveBeenCalled();
  });
});
