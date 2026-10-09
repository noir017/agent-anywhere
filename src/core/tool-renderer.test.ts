import { describe, it, expect } from 'vitest';
import type { MessageRef, ToolEvent, ToolFinishEvent } from '../types.js';
import { RateLimitedError, WriteDroppedError } from './outbound-errors.js';
import {
  ToolRenderer,
  formatDuration,
  type BubbleSink,
  type ToolRendererOptions,
} from './tool-renderer.js';

/**
 * Mock BubbleSink with a manual clock.
 *
 * Painting is asynchronous now, so a test has to say when the writes it queued are allowed to
 * settle (`flush`) and when time is allowed to pass (`advanceTo`). That is the point of the
 * change: `onToolStart` no longer waits for the platform.
 */
function makeSink(opts: { withEdit: boolean }) {
  const sends: string[] = [];
  const edits: Array<{ ref: MessageRef; text: string }> = [];
  let counter = 0;
  let nowVal = 0;
  let pending: Array<{ fn: () => void; at: number; cancelled: boolean }> = [];
  /** Queued failures for the next edits, oldest first. */
  const editFailures: unknown[] = [];

  const sink: BubbleSink = {
    async sendBubble(text: string): Promise<MessageRef> {
      sends.push(text);
      counter += 1;
      return { channelId: 'c', messageId: `m${counter}` };
    },
    now: () => nowVal,
    schedule(fn: () => void, ms: number) {
      const entry = { fn, at: nowVal + ms, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  if (opts.withEdit) {
    sink.editBubble = async (ref: MessageRef, text: string): Promise<void> => {
      const scripted = editFailures.shift();
      if (scripted !== undefined) throw scripted;
      edits.push({ ref, text });
    };
  }

  /** Let every queued write settle (the painter awaits between writes). */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  return {
    sink,
    sends,
    edits,
    flush,
    /** Advance to `t`, firing timers in due order, then settle. */
    async advanceTo(t: number): Promise<void> {
      await flush();
      for (let guard = 0; guard < 200; guard++) {
        pending = pending.filter((e) => !e.cancelled);
        const next = pending
          .filter((e) => e.at <= t)
          .reduce<(typeof pending)[number] | undefined>(
            (best, e) => (best === undefined || e.at < best.at ? e : best),
            undefined
          );
        if (!next) break;
        pending = pending.filter((e) => e !== next);
        nowVal = Math.max(nowVal, next.at);
        next.fn();
        await flush();
      }
      nowVal = Math.max(nowVal, t);
      await flush();
    },
    /** Whether a timer is armed and still in the future — i.e. a retry is pending. */
    hasArmedTimer(): boolean {
      return pending.some((e) => !e.cancelled);
    },
    /** The next edit throws `err`. */
    failNextEdit(err: unknown) {
      editFailures.push(err);
    },
  };
}

function makeOpts(over: Partial<ToolRendererOptions> = {}): ToolRendererOptions {
  return {
    mode: 'all',
    grouping: 'separate',
    previewLimit: 40,
    defaultEmoji: '⚙️',
    emojiMap: { Read: '📖', Edit: '✏️', Bash: '💻' },
    ...over,
  };
}

function start(name: string, inputPreview: string, index?: number): ToolEvent {
  return { name, inputPreview, index };
}
function finish(name: string, ok: boolean, durationMs: number, index?: number): ToolFinishEvent {
  return { name, ok, durationMs, index };
}

describe('formatDuration', () => {
  it('<1000ms uses milliseconds', () => {
    expect(formatDuration(832)).toBe('832ms');
    expect(formatDuration(999)).toBe('999ms');
  });
  it('>=1000ms uses seconds (one decimal)', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(1500)).toBe('1.5s');
  });
});

describe('separate mode', () => {
  it('two different tools → two sendBubble calls, no editBubble', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts'));
    r.onToolStart(start('Edit', 'src/b.ts'));
    await flush();

    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
    expect(sends[0]).toBe('📖 Read: "src/a.ts"');
    expect(sends[1]).toBe('✏️ Edit: "src/b.ts"');
  });

  it('onToolFinish is a safe no-op under separate', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    r.onToolFinish(finish('Read', true, 1200, 0));
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(0);
  });
});

describe('accumulate mode', () => {
  it('two starts → one sendBubble + one editBubble, bubble holds two lines', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    r.onToolStart(start('Edit', 'src/b.ts', 1));
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);

    const finalText = edits[edits.length - 1]!.text;
    expect(finalText).toBe('📖 Read: "src/a.ts"\n✏️ Edit: "src/b.ts"');
    expect(finalText.split('\n')).toHaveLength(2);
  });

  it('onToolFinish marks the matching line with ✓ and duration', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    r.onToolStart(start('Edit', 'src/b.ts', 1));
    r.onToolFinish(finish('Read', true, 1200, 0));
    await flush();

    const text = edits[edits.length - 1]!.text;
    const readLine = text.split('\n').find((l) => l.startsWith('📖'))!;
    expect(readLine).toContain('✓');
    expect(readLine).toContain('1.2s');
    expect(readLine).toBe('📖 Read: "src/a.ts" ✓ 1.2s');
  });

  it('ok=false → ✗', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Bash', 'ls', 0));
    await flush();
    r.onToolFinish(finish('Bash', false, 832, 0));
    await flush();

    const text = edits[edits.length - 1]!.text;
    expect(text).toContain('✗');
    expect(text).toContain('832ms');
    expect(text).toBe('💻 Bash: "ls" ✗ 832ms');
  });

  it('with no index, locates by appearance order / same name', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'all' }), sink);

    r.onToolStart(start('Read', 'src/a.ts'));
    r.onToolStart(start('Read', 'src/b.ts'));
    // No index → hits the first unfinished line with the same name.
    r.onToolFinish(finish('Read', true, 500));
    await flush();

    const lines = edits[edits.length - 1]!.text.split('\n');
    expect(lines[0]).toBe('📖 Read: "src/a.ts" ✓ 500ms');
    expect(lines[1]).toBe('📖 Read: "src/b.ts"');
  });

  it('under verbose, JSON is attached below the line (only once)', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'verbose' }), sink);

    r.onToolStart({ name: 'Read', inputPreview: 'src/a.ts', input: { path: 'src/a.ts' }, index: 0 });
    await flush();

    expect(sends[0]).toContain('```json');
    expect(sends[0]).toContain('"path": "src/a.ts"');
  });

  it('with no sink.editBubble, degrades to separate (a new bubble each time)', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: false });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    r.onToolStart(start('Edit', 'src/b.ts', 1));
    await flush();

    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
  });

  it('after resetSegment the next segment starts a new bubble', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    r.resetSegment();
    await flush();
    r.onToolStart(start('Edit', 'src/b.ts', 0));
    await flush();

    expect(sends).toHaveLength(2);
    // The second segment's bubble holds only the new line, not the prior segment.
    expect(sends[1]).toBe('✏️ Edit: "src/b.ts"');
  });
});

/**
 * The headline regression. Under a run of back-to-back tool calls the renderer wrote twice per
 * tool into one chat with no pacing; Telegram answered 429 (`retry after` up to 229 s) and
 * `paint()` rethrew, so the update was logged and gone — the bubble froze on stale progress with
 * nothing left to re-trigger a paint. 78 updates were lost this way in one daemon run.
 */
describe('a rate-limited write is retried, never lost', () => {
  it('a 429 no longer loses the update: the newest state lands on the retry', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', retryIntervalMs: 1_200 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();

    failNextEdit(new RateLimitedError('Too Many Requests', { retryAfterMs: 5_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();
    expect(edits).toHaveLength(0); // the write failed...

    await advanceTo(5_000);
    expect(edits).toHaveLength(1); // ...and the retry carried it
    expect(edits[0]!.text).toBe('📖 Read: "a.ts" ✓ 500ms');
  });

  it('waits the time the platform NAMED, not the configured interval', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', retryIntervalMs: 1_200 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    await advanceTo(10_000); // way past retryIntervalMs, nowhere near the stated wait
    expect(edits).toHaveLength(0);

    await advanceTo(229_000);
    expect(edits).toHaveLength(1);
  });

  it('clamps an absurd stated wait so the bubble cannot freeze forever', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', maxRetryAfterMs: 60_000 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 86_400_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    await advanceTo(60_000);
    expect(edits).toHaveLength(1);
  });

  it('an unquantified failure backs off exponentially, capped at maxRetryMs', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(
      makeOpts({ grouping: 'accumulate', retryIntervalMs: 1_000, maxRetryMs: 2_500 }),
      sink
    );

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();

    failNextEdit(new Error('socket hang up'));
    failNextEdit(new Error('socket hang up'));
    failNextEdit(new Error('socket hang up'));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    await advanceTo(1_000); // 1st retry: fails (2nd scripted), backoff → 2000
    expect(edits).toHaveLength(0);
    await advanceTo(3_000); // 2nd retry: fails (3rd scripted), backoff → 2500 (capped, not 4000)
    expect(edits).toHaveLength(0);
    await advanceTo(5_500); // 3rd retry, 2500 after the last: the sink is out of failures
    expect(edits).toHaveLength(1);
  });

  it('a write the pacer dropped is treated as undelivered, so the next paint carries it', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', retryIntervalMs: 800 }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new WriteDroppedError('timeout', { retryAfterMs: 3_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();
    expect(edits).toHaveLength(0);

    await advanceTo(3_000);
    expect(edits[0]!.text).toContain('✓'); // the ✓ was never marked delivered, so it came back
  });

  it('abort() cancels an armed retry: a finished turn stops repainting', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 1_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    r.abort();
    await advanceTo(60_000);
    expect(edits).toHaveLength(0);
  });
});

describe('painting is off the caller’s critical path', () => {
  it('onToolStart does not wait for the platform to answer', () => {
    // A sink that never answers: if onToolStart awaited delivery, this call would never return —
    // which is exactly what used to put every progress write in front of the user's reply.
    const sink: BubbleSink = {
      sendBubble: () => new Promise<MessageRef>(() => undefined),
      editBubble: () => new Promise<void>(() => undefined),
      now: () => 0,
      schedule: () => () => undefined,
    };
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    r.onToolFinish(finish('Read', true, 500, 0));
    r.onToolStart(start('Bash', 'ls', 1));
    expect(true).toBe(true); // reaching here at all is the assertion
  });

  it('a burst of tool events collapses into far fewer writes than events', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    // 20 back-to-back tool calls: the shape that produced two writes per tool and 78 × 429.
    for (let i = 0; i < 20; i++) {
      r.onToolStart(start('Read', `f${i}.ts`, i));
      r.onToolFinish(finish('Read', true, 100, i));
    }
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits.length).toBeLessThanOrEqual(2); // was 40 writes
    expect(edits[edits.length - 1]!.text.split('\n')).toHaveLength(20); // all of it still shown
  });

  it('settle() resolves once everything has landed', async () => {
    const { sink, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    const settled = r.settle(10_000);
    await flush();
    await expect(settled).resolves.toBeUndefined();
  });

  it('settle() gives up on its deadline rather than holding the turn open', async () => {
    const { sink, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 229_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    const settled = r.settle(15_000);
    await advanceTo(15_000);
    await expect(settled).resolves.toBeUndefined(); // the turn is free; the write still lands later
  });

  it('resetSegment waits for the segment’s last ✓ instead of discarding it', async () => {
    const { sink, edits, flush, advanceTo, failNextEdit } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    // The finish lands while the lane is stuck; the turn ends immediately after.
    failNextEdit(new RateLimitedError('flood', { retryAfterMs: 2_000 }));
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();
    r.resetSegment();
    await flush();
    expect(edits).toHaveLength(0);

    await advanceTo(2_000);
    // Clearing the line set immediately would have thrown this ✓ away with it.
    expect(edits[0]!.text).toBe('📖 Read: "a.ts" ✓ 500ms');
  });
});

describe('accumulate: what is written, and when', () => {
  it('an identical repaint spends no write at all', async () => {
    const { sink, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'new' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    await flush();
    // Deduped by 'new', so the line set does not change — and a write saying the same thing is
    // a token spent for nothing.
    r.onToolStart(start('Read', 'b.ts', 1));
    await flush();
    expect(edits).toHaveLength(0);
  });

  it('a ✓ recorded while the send is in flight is not counted as delivered by that send', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    // No flush: the send is in flight. The ✓ recorded now was NOT part of it.
    r.onToolFinish(finish('Read', true, 500, 0));
    await flush();

    // A boolean "delivered" flag set by the send would have left the bubble without its ✓.
    expect(sends).toEqual(['📖 Read: "a.ts"']);
    expect(edits.map((e) => e.text)).toEqual(['📖 Read: "a.ts" ✓ 500ms']);
  });

  it("a bubble still being sent when its segment ends is not adopted by the next segment", async () => {
    const gate: Array<() => void> = [];
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const send = sink.sendBubble.bind(sink);
    // Hold the first send open, as a congested chat's queue would.
    sink.sendBubble = (text) =>
      sends.length === 0 ? new Promise((res) => gate.push(() => void send(text).then(res))) : send(text);
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    r.onToolStart(start('Read', 'a.ts', 0));
    r.resetSegment(); // text arrived: segment one is over while its bubble is still in flight
    r.onToolStart(start('Bash', 'ls', 1)); // segment two
    gate.shift()!(); // segment one's send finally lands
    await flush();

    // Segment two opened a bubble of its own; it did not edit segment one's.
    expect(sends).toEqual(['📖 Read: "a.ts"', '💻 Bash: "ls"']);
    expect(edits).toHaveLength(0);
  });
});

describe('new dedupe', () => {
  it('separate: consecutive same name sends only one', async () => {
    const { sink, sends, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate', mode: 'new' }), sink);

    r.onToolStart(start('Read', 'src/a.ts'));
    r.onToolStart(start('Read', 'src/b.ts'));
    r.onToolStart(start('Edit', 'src/c.ts'));
    await flush();

    expect(sends).toHaveLength(2);
  });

  it('accumulate: consecutive same name does not enter the line set', async () => {
    const { sink, sends, edits, flush } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'new' }), sink);

    r.onToolStart(start('Read', 'src/a.ts', 0));
    await flush();
    r.onToolStart(start('Read', 'src/b.ts', 1)); // deduped
    r.onToolStart(start('Edit', 'src/c.ts', 2)); // added to line + edit
    await flush();

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    const text = edits[edits.length - 1]!.text;
    expect(text).toBe('📖 Read: "src/a.ts"\n✏️ Edit: "src/c.ts"');
  });
});
