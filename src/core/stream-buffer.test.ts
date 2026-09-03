import { describe, it, expect } from 'vitest';
import type { MessageRef } from '../types.js';
import {
  StreamBuffer,
  splitIntoChunks,
  splitByMeasure,
  shouldSkipFlush,
  type StreamBufferOptions,
  type StreamSink,
} from './stream-buffer.js';

/** Parse the "(i/total) " prefix; returns {i,total,body} or null. */
function parseLabel(chunk: string): { i: number; total: number; body: string } | null {
  const m = /^\((\d+)\/(\d+)\) ([\s\S]*)$/.exec(chunk);
  if (!m) return null;
  return { i: Number(m[1]), total: Number(m[2]), body: m[3]! };
}

/** Count ``` fences; even means paired. */
function fenceCount(s: string): number {
  return (s.match(/```/g) ?? []).length;
}

describe('splitIntoChunks', () => {
  it('short text is not chunked and not labeled', () => {
    expect(splitIntoChunks('hello', 100)).toEqual(['hello']);
  });

  it('exactly equal to limit is not chunked', () => {
    const text = 'x'.repeat(50);
    expect(splitIntoChunks(text, 50)).toEqual([text]);
  });

  it('empty string returns a single chunk, not labeled', () => {
    expect(splitIntoChunks('', 100)).toEqual(['']);
  });

  it('long plain text splits on newlines and adds (i/total) labels', () => {
    const text = ['line-one', 'line-two', 'line-three', 'line-four'].join('\n');
    const limit = 20;
    const chunks = splitIntoChunks(text, limit, true);

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, idx) => {
      const p = parseLabel(c);
      expect(p).not.toBeNull();
      expect(p!.i).toBe(idx + 1);
      expect(p!.total).toBe(chunks.length);
    });
    // Label counts against the budget: labeled chunk length stays within limit.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    const joined = chunks.map((c) => parseLabel(c)!.body).join('\n');
    expect(joined.replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });

  it('prefers breaking at spaces without splitting words', () => {
    const text = 'alpha beta gamma delta epsilon zeta';
    const limit = 22; // tiny content budget after the label forces multiple chunks
    const chunks = splitIntoChunks(text, limit, true);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit);
      const body = parseLabel(c)!.body;
      // No split mid-word: body has no broken leading/trailing whitespace.
      expect(body).toBe(body.trim());
    }
    // Recovered word set matches the original (no word torn apart).
    const words = chunks.flatMap((c) => parseLabel(c)!.body.split(/\s+/));
    expect(words.filter(Boolean)).toEqual(text.split(' '));
  });

  it('a single overlong token with no spaces is hard-cut', () => {
    const token = 'a'.repeat(200);
    const limit = 30;
    const chunks = splitIntoChunks(token, limit, true);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    const joined = chunks.map((c) => parseLabel(c)!.body).join('');
    expect(joined).toBe(token);
  });

  it('a code block is kept whole when the budget allows (not split), fences always paired', () => {
    // Large enough limit to keep the whole code block in one slice; long
    // surrounding text forces chunking.
    const pre = '前置文本'.repeat(20);
    const code = '```ts\nconst a = 1;\nconst b = 2;\n```';
    const post = '后置文本'.repeat(20);
    const text = `${pre}\n${code}\n${post}`;
    const limit = 80;
    const chunks = splitIntoChunks(text, limit, true);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(fenceCount(c) % 2).toBe(0);
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    // Code block stays whole in one chunk (both lines together, fences intact).
    const codeChunk = chunks.find((c) => c.includes('const a = 1;'));
    expect(codeChunk).toBeDefined();
    expect(codeChunk!).toContain('const b = 2;');
    expect(parseLabel(codeChunk!)!.body.startsWith('```ts')).toBe(true);
    expect(codeChunk!.endsWith('```')).toBe(true);
  });

  it('an overlong code block, once split, keeps each slice fenced and language-tagged', () => {
    const codeLines = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`);
    const text = '```js\n' + codeLines.join('\n') + '\n```';
    const limit = 50;
    const chunks = splitIntoChunks(text, limit, true);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const body = parseLabel(c)!.body;
      expect(fenceCount(body) % 2).toBe(0);
      // Slices with code start with ```js (language tag preserved).
      if (body.includes('const v')) {
        expect(body.startsWith('```js')).toBe(true);
        expect(body.endsWith('```')).toBe(true);
      }
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    const codeContent = chunks
      .map((c) => parseLabel(c)!.body)
      .join('\n')
      .replace(/```js\n?/g, '')
      .replace(/```/g, '');
    for (const line of codeLines) expect(codeContent).toContain(line);
  });

  it('label width counts against the budget: labeled length never exceeds limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `这是第${i}行中文内容测试`).join('\n');
    const limit = 35;
    const chunks = splitIntoChunks(text, limit, true);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(limit);
    // Enough chunks to force a two-digit total, exercising adaptive label width.
    expect(chunks.length).toBeGreaterThanOrEqual(10);
  });

  it('default (withLabels=false): multiple chunks but no (i/total) labels', () => {
    const text = ['line-one', 'line-two', 'line-three', 'line-four'].join('\n');
    const limit = 20;
    const chunks = splitIntoChunks(text, limit); // default: no labels
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(parseLabel(c)).toBeNull();
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    expect(chunks.join('\n').replace(/\n+/g, '\n')).toBe(text.replace(/\n+/g, '\n'));
  });
});

describe('shouldSkipFlush', () => {
  it('unchanged + non-final → skip (avoid redundant edit)', () => {
    expect(
      shouldSkipFlush({
        rendered: 'abc',
        lastRenderedBody: 'abc',
        final: false,
        overflowSent: false,
        chunkCount: 1,
      })
    ).toBe(true);
  });

  it('unchanged + final but overflow chunks pending (chunkCount>1 and not yet sent) → do not skip', () => {
    expect(
      shouldSkipFlush({
        rendered: 'abc',
        lastRenderedBody: 'abc',
        final: true,
        overflowSent: false,
        chunkCount: 3,
      })
    ).toBe(false);
  });

  it('unchanged + final and overflow already sent → skip', () => {
    expect(
      shouldSkipFlush({
        rendered: 'abc',
        lastRenderedBody: 'abc',
        final: true,
        overflowSent: true,
        chunkCount: 3,
      })
    ).toBe(true);
  });

  it('unchanged + final and only 1 chunk → skip (nothing to do)', () => {
    expect(
      shouldSkipFlush({
        rendered: 'abc',
        lastRenderedBody: 'abc',
        final: true,
        overflowSent: false,
        chunkCount: 1,
      })
    ).toBe(true);
  });

  it('text changed → never skip (non-final)', () => {
    expect(
      shouldSkipFlush({
        rendered: 'abcd',
        lastRenderedBody: 'abc',
        final: false,
        overflowSent: false,
        chunkCount: 1,
      })
    ).toBe(false);
  });

  it('text changed → never skip (final)', () => {
    expect(
      shouldSkipFlush({
        rendered: 'abcd',
        lastRenderedBody: 'abc',
        final: true,
        overflowSent: true,
        chunkCount: 1,
      })
    ).toBe(false);
  });
});

interface FakeSink extends StreamSink {
  sends: string[];
  edits: Array<{ ref: MessageRef; text: string }>;
  deletes: MessageRef[];
  setNow(t: number): void;
  runTimers(): void;
  failEdits(n: number): void;
}

/**
 * Controllable sink: advance now manually, fire registered timers manually, set
 * a number of edit failures.
 *  - withDelete=false omits the delete method (platform not implementing/injecting it).
 *  - deleteThrows=true makes delete throw (delete-error fallback case).
 */
function makeSink(opts: { withDelete?: boolean; deleteThrows?: boolean } = {}): FakeSink {
  const { withDelete = true, deleteThrows = false } = opts;
  let nowVal = 0;
  let editFailRemaining = 0;
  const pending: Array<{ fn: () => void; at: number }> = [];
  let msgSeq = 0;

  const sink: FakeSink = {
    sends: [],
    edits: [],
    deletes: [],
    async send(text: string): Promise<MessageRef> {
      sink.sends.push(text);
      return { address: { channel: 'c' }, messageId: `m${++msgSeq}` };
    },
    async edit(ref: MessageRef, text: string): Promise<void> {
      if (editFailRemaining > 0) {
        editFailRemaining--;
        throw new Error('rate-limited');
      }
      sink.edits.push({ ref, text });
    },
    now: () => nowVal,
    schedule(fn: () => void, ms: number): () => void {
      const entry = { fn, at: nowVal + ms };
      pending.push(entry);
      return () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    setNow(t: number) {
      nowVal = t;
    },
    runTimers() {
      // Fire all pending timers (one simple round).
      const due = pending.splice(0, pending.length);
      for (const e of due) e.fn();
    },
    failEdits(n: number) {
      editFailRemaining = n;
    },
  };
  if (withDelete) {
    sink.delete = async (ref: MessageRef): Promise<void> => {
      sink.deletes.push(ref);
      if (deleteThrows) throw new Error('delete-failed');
    };
  }
  return sink;
}

/** Drive the buffer into degraded state: first send succeeds, then edits fail to the threshold. */
async function driveIntoDegraded(buf: StreamBuffer, sink: FakeSink, failures: number): Promise<void> {
  buf.push('ab'); // first send succeeds (send unaffected by failEdits) → gets primaryRef
  await Promise.resolve();
  await Promise.resolve();
  sink.failEdits(99);
  for (let k = 0; k < failures; k++) {
    sink.setNow(sink.now() + 100000); // jump past backoff to guarantee a trigger
    buf.push('cd'); // each addition changes rendered → triggers a (failing) edit
    // Extra microtask rounds so this edit settles on the flushChain before the next.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function makeOpts(over: Partial<StreamBufferOptions> = {}): StreamBufferOptions {
  return {
    charThreshold: 10,
    flushIntervalMs: 800,
    cursor: '▌',
    maxBackoffMs: 10000,
    maxFailuresBeforeFallback: 3,
    silentToken: '[SILENT]',
    maxMessageLength: 2000,
    ...over,
  };
}

describe('StreamBuffer dual-trigger and degradation', () => {
  it('accumulating to charThreshold triggers one initial send', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 5 }), sink);

    buf.push('hello world'); // 11 chars >= 5 → triggers
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello world▌'); // first send carries the cursor
  });

  it('below the threshold does not trigger immediately, flushes when the timer expires', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 100 }), sink);

    buf.push('hi'); // 2 < 100, no trigger, arms a timer
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);

    sink.setNow(1000); // past flushIntervalMs
    sink.runTimers();
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hi▌');
  });

  it('skips the edit call when the text is unchanged', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 1 }), sink);

    buf.push('abc'); // initial send
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    // Advance time and flush again, but no new text → rendered unchanged → skipped.
    sink.setNow(5000);
    buf.push(''); // doesn't change acc
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.edits.length).toBe(0);
  });

  it('new content after the initial send triggers an in-place edit', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 3 }), sink);

    buf.push('aaa');
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    sink.setNow(5000);
    buf.push('bbbb'); // adds 4 >= 3
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.edits.length).toBe(1);
    expect(sink.edits[0]!.text).toBe('aaabbbb▌');
  });

  it('after consecutive edit failures reach maxFailuresBeforeFallback it degrades, whole-sends on complete', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, maxFailuresBeforeFallback: 3 });
    const buf = new StreamBuffer(opts, sink);

    // First send succeeds (send unaffected by failEdits).
    buf.push('ab');
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    // Next 3 edits all fail → triggers degradation.
    sink.failEdits(99);
    for (let k = 0; k < 3; k++) {
      sink.setNow(sink.now() + 100000); // jump past backoff to guarantee a trigger
      buf.push('cd');
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(sink.edits.length).toBe(0); // degraded by now, no edit written

    const sendsBefore = sink.sends.length;
    await buf.complete();
    await Promise.resolve();
    // Degraded path: whole-send on complete, with no cursor.
    expect(sink.sends.length).toBeGreaterThan(sendsBefore);
    expect(sink.sends[sink.sends.length - 1]).not.toContain(opts.cursor);
  });

  it('complete() after degradation: deletes the frozen preview and whole-sends the full text, no cursor remnant', async () => {
    const sink = makeSink({ withDelete: true });
    const opts = makeOpts({ charThreshold: 2, maxFailuresBeforeFallback: 3 });
    const buf = new StreamBuffer(opts, sink);

    await driveIntoDegraded(buf, sink, 3);
    expect(sink.edits.length).toBe(0); // degraded: no edit ever written
    // The frozen cursor preview (the first send) is still present.
    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toContain(opts.cursor);

    const sendsBefore = sink.sends.length;
    await buf.complete();
    await Promise.resolve();

    expect(sink.deletes.length).toBe(1); // frozen primaryRef deleted
    // Full text emitted as a new message.
    expect(sink.sends.length).toBeGreaterThan(sendsBefore);
    const finalSend = sink.sends[sink.sends.length - 1];
    expect(finalSend).toBe('abcdcdcd'); // ab + 3×cd, no cursor
    expect(finalSend).not.toContain(opts.cursor);
    expect(sink.edits.length).toBe(0); // strip fallback not used (delete + send path)
  });

  it('complete() after degradation: with no sink.delete, falls back to stripping the cursor (edits primary to drop the cursor, no ▌ remnant)', async () => {
    const sink = makeSink({ withDelete: false });
    const opts = makeOpts({ charThreshold: 2, maxFailuresBeforeFallback: 3 });
    const buf = new StreamBuffer(opts, sink);

    await driveIntoDegraded(buf, sink, 3);
    expect(sink.delete).toBeUndefined();
    sink.failEdits(0); // stop failing so the strip-fallback edit can land
    const sendsBefore = sink.sends.length;

    await buf.complete();
    await Promise.resolve();

    // No delete → no new whole-send (strip fallback makes the edited primary final).
    expect(sink.sends.length).toBe(sendsBefore);
    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('abcdcdcd');
    expect(lastEdit.text).not.toContain(opts.cursor);
    // No frozen cursor left anywhere.
    expect(sink.edits.every((e) => !e.text.includes(opts.cursor))).toBe(true);
  });

  it('complete() after degradation: when delete throws, falls back to strip, no dirty cursor remnant, no exception', async () => {
    const sink = makeSink({ withDelete: true, deleteThrows: true });
    const opts = makeOpts({ charThreshold: 2, maxFailuresBeforeFallback: 3 });
    const buf = new StreamBuffer(opts, sink);

    await driveIntoDegraded(buf, sink, 3);
    sink.failEdits(0); // stop failing so the post-delete strip-fallback edit can land
    const sendsBefore = sink.sends.length;

    // complete must not throw (best-effort).
    await expect(buf.complete()).resolves.toBeUndefined();
    await Promise.resolve();

    expect(sink.deletes.length).toBe(1); // delete attempted (and threw)
    // Falls back to strip: no new whole-send, edits primary to drop the cursor.
    expect(sink.sends.length).toBe(sendsBefore);
    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('abcdcdcd');
    expect(sink.edits.every((e) => !e.text.includes(opts.cursor))).toBe(true);
  });

  it('abort() then complete() after degradation: performs no further writes/deletes', async () => {
    const sink = makeSink({ withDelete: true });
    const opts = makeOpts({ charThreshold: 2, maxFailuresBeforeFallback: 3 });
    const buf = new StreamBuffer(opts, sink);

    await driveIntoDegraded(buf, sink, 3);
    const sendsBefore = sink.sends.length;
    const editsBefore = sink.edits.length;

    buf.abort();
    await buf.complete(); // after abort, complete returns early: no write/delete
    await Promise.resolve();

    expect(sink.sends.length).toBe(sendsBefore);
    expect(sink.edits.length).toBe(editsBefore);
    expect(sink.deletes.length).toBe(0);
  });

  it('complete() drops the streaming cursor', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello'); // first send carries the cursor
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends[0]).toContain(opts.cursor);

    sink.setNow(5000);
    await buf.complete();
    await Promise.resolve();
    // The final write (edit) has no cursor.
    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('hello');
    expect(lastEdit.text).not.toContain(opts.cursor);
  });

  it('complete({ footer }): on normal completion the footer is appended to the end of the final message', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello'); // first send carries the cursor
    await Promise.resolve();
    await Promise.resolve();

    sink.setNow(5000);
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();

    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('hello\n\nclaude-opus · ~/repo');
    expect(lastEdit.text).not.toContain(opts.cursor);
  });

  it('complete({ footer }): an empty footer is not appended', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();

    sink.setNow(5000);
    await buf.complete({ footer: '' });
    await Promise.resolve();

    const lastEdit = sink.edits[sink.edits.length - 1]!;
    expect(lastEdit.text).toBe('hello');
  });

  it('complete({ footer }): [SILENT] body sends no message at all (footer also absent)', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts(), sink);
    buf.push('[SILENT]');
    await Promise.resolve();
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('regression: empty cursor + overlong text, complete must send all overflow chunks (previously only 1/N)', async () => {
    const sink = makeSink();
    // Regression: with cursor='', streaming render (acc) equals final render
    // (acc, no footer), so final was early-exited as "unchanged" and the overflow
    // chunks were lost forever. This pins that down.
    const buf = new StreamBuffer(
      makeOpts({ cursor: '', maxMessageLength: 60, charThreshold: 5 }),
      sink
    );
    const body = 'x'.repeat(220); // far over 60 → certainly multiple chunks
    buf.push(body);
    await Promise.resolve();
    await Promise.resolve();
    await buf.complete();
    await Promise.resolve();

    // Multiple unlabeled sends, fully recoverable (chunks 2..N must not be lost).
    expect(sink.sends.length).toBeGreaterThan(1);
    for (const s of sink.sends) expect(parseLabel(s)).toBeNull();
    const lastEdit = sink.edits.at(-1)?.text;
    const primaryFinal = lastEdit ?? sink.sends[0]; // primary may be finished by an edit
    expect([primaryFinal, ...sink.sends.slice(1)].join('')).toBe(body);
  });

  it('complete({ footer }): empty body (never pushed visible text) appends no footer and sends no message', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts(), sink);
    // Never pushed anything → acc empty → no visible body.
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('[SILENT] sends no message at all', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts(), sink);
    buf.push('[SILENT]');
    await Promise.resolve();
    await buf.complete();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('complete()\'s final write is not swallowed while a streaming flush is in flight (cursor dropped)', async () => {
    // Race regression: the first send hangs (manually resolved) to simulate an
    // in-flight flush; complete() is called during its await, then the send is
    // released. The final write must drop the trailing cursor (not be swallowed
    // by a re-entrancy guard).
    let resolveFirstSend: ((ref: MessageRef) => void) | null = null;
    let sendCount = 0;
    let nowVal = 0;
    let msgSeq = 0;
    const sends: string[] = [];
    const edits: Array<{ ref: MessageRef; text: string }> = [];

    const sink: StreamSink = {
      async send(text: string): Promise<MessageRef> {
        sends.push(text);
        if (++sendCount === 1) {
          // First send hangs (in-flight) until released externally.
          return new Promise<MessageRef>((res) => {
            resolveFirstSend = res;
          });
        }
        return { address: { channel: 'c' }, messageId: `m${++msgSeq}` };
      },
      async edit(ref: MessageRef, text: string): Promise<void> {
        edits.push({ ref, text });
      },
      now: () => nowVal,
      schedule(_fn: () => void, _ms: number): () => void {
        return () => {};
      },
    };

    const opts = makeOpts({ charThreshold: 2 });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello'); // triggers first send, which hangs (in-flight)
    await Promise.resolve();
    await Promise.resolve();
    expect(sends.length).toBe(1);
    expect(sends[0]).toBe('hello▌'); // streaming write carries the cursor

    // End of turn: a re-entrancy-guarded impl would no-op and drop the final write.
    nowVal = 5000;
    const done = buf.complete();
    // Release the hung first send so the in-flight flush settles and the chain runs final.
    expect(resolveFirstSend).not.toBeNull();
    resolveFirstSend!({ address: { channel: 'c' }, messageId: 'm-first' });
    await done;
    await Promise.resolve();

    // Final write (edit on primary) is the cursor-free body.
    const lastEdit = edits[edits.length - 1]!;
    expect(lastEdit).toBeDefined();
    expect(lastEdit.text).toBe('hello');
    expect(lastEdit.text).not.toContain(opts.cursor);
  });

  it('push() after abort() produces no new send/edit', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ charThreshold: 2 }), sink);

    buf.push('ab'); // initial send
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(1);

    const sendsBefore = sink.sends.length;
    const editsBefore = sink.edits.length;

    buf.abort();
    sink.setNow(5000);
    buf.push('cdef'); // post-abort delta must not trigger any write
    await Promise.resolve();
    await Promise.resolve();
    sink.runTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(sendsBefore);
    expect(sink.edits.length).toBe(editsBefore);
  });
});

// ============================================================================
// noEdit mode (editMessage=false constrained platforms: QQ/LINE/WeCom)
// ============================================================================

describe('StreamBuffer noEdit mode', () => {
  it('sends nothing during push, complete() emits the accumulated text as a single new send, no cursor, no edit', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, noEdit: true });
    const buf = new StreamBuffer(opts, sink);

    // Multiple pushes crossing the char threshold and timer: noEdit never sends mid-stream.
    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();
    buf.push(' world');
    await Promise.resolve();
    await Promise.resolve();
    sink.setNow(5000);
    sink.runTimers(); // even an expired timer must not trigger a mid-stream send
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);

    await buf.complete();
    await Promise.resolve();
    await Promise.resolve();

    // Finish: accumulated text emitted as a single new message, no edit, no cursor.
    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello world');
    expect(sink.edits.length).toBe(0);
    expect(sink.sends[0]).not.toContain(opts.cursor);
  });

  it('with cursor:"" (production setting), complete() still sends — mid-stream no-op flushes must not mark the text as delivered', async () => {
    // Regression: turn-runner passes cursor:'' — the streaming and final renders are then
    // IDENTICAL. The degraded mid-stream branch used to advance lastRenderedBody without
    // sending, so the final flush saw "unchanged" and skipped the whole-send: noEdit
    // platforms (DingTalk/QQ/LINE/WeCom) never delivered any reply. (The '▌' cursor in the
    // other tests masked this by making the renders differ.)
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, cursor: '', noEdit: true });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello'); // crosses charThreshold → triggers a mid-stream (no-op) flush
    await Promise.resolve();
    await Promise.resolve();
    buf.push(' world'); // and again
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0); // nothing mid-stream, per noEdit design

    await buf.complete(); // no footer: final render === mid-stream render
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello world');
    expect(sink.edits.length).toBe(0);
  });

  it('under noEdit, overlong text on complete() still splits via splitIntoChunks into multiple messages', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, noEdit: true, maxMessageLength: 20 });
    const buf = new StreamBuffer(opts, sink);

    const text = ['line-one', 'line-two', 'line-three', 'line-four'].join('\n');
    buf.push(text);
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.sends.length).toBe(0); // nothing mid-stream

    await buf.complete();
    await Promise.resolve();
    await Promise.resolve();

    // Overlong → multiple sends; each within budget, unlabeled, cursor-free, no edit.
    expect(sink.sends.length).toBeGreaterThan(1);
    for (const s of sink.sends) {
      expect(s.length).toBeLessThanOrEqual(opts.maxMessageLength);
      expect(s).not.toContain(opts.cursor);
      expect(/^\(\d+\/\d+\) /.test(s)).toBe(false);
    }
    expect(sink.edits.length).toBe(0);
  });

  it('under noEdit, complete() after abort() sends no message', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, noEdit: true });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello world');
    await Promise.resolve();
    await Promise.resolve();

    buf.abort();
    await buf.complete();
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });

  it('noEdit final still appends the footer (at the end of the last message, no cursor, no edit)', async () => {
    const sink = makeSink();
    const opts = makeOpts({ charThreshold: 2, noEdit: true });
    const buf = new StreamBuffer(opts, sink);

    buf.push('hello');
    await Promise.resolve();
    await Promise.resolve();

    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink.sends.length).toBe(1);
    expect(sink.sends[0]).toBe('hello\n\nclaude-opus · ~/repo');
    expect(sink.edits.length).toBe(0);
    expect(sink.sends[0]).not.toContain(opts.cursor);
  });

  it('under noEdit, a [SILENT] body sends no message at all', async () => {
    const sink = makeSink();
    const buf = new StreamBuffer(makeOpts({ noEdit: true }), sink);
    buf.push('[SILENT]');
    await Promise.resolve();
    await buf.complete({ footer: 'claude-opus · ~/repo' });
    await Promise.resolve();
    expect(sink.sends.length).toBe(0);
    expect(sink.edits.length).toBe(0);
  });
});

describe('splitByMeasure (render-aware chunking)', () => {
  const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');

  it('with the default (identity) measure, behaves exactly like splitIntoChunks', () => {
    const text = words(50);
    expect(splitByMeasure(text, 60)).toEqual(splitIntoChunks(text, 60));
  });

  it('a shrinking measure never triggers a needless re-split (full-size chunks kept)', () => {
    const text = words(50);
    // measure roughly halves length: every char-split chunk (<=60) measures <=30 < 60 → no re-split.
    const chunks = splitByMeasure(text, 60, (s) => Math.ceil(s.length / 2));
    expect(chunks).toEqual(splitIntoChunks(text, 60));
  });

  it('an expanding measure shrinks chunks so each rendered length stays within the limit', () => {
    const text = words(80);
    const limit = 60;
    const measure = (s: string) => s.length * 2; // 2x expansion (like a worst-case table)
    const chunks = splitByMeasure(text, limit, measure);
    for (const c of chunks) expect(measure(c)).toBeLessThanOrEqual(limit);
    // more, smaller chunks than a naive raw-char split would produce
    expect(chunks.length).toBeGreaterThan(splitIntoChunks(text, limit).length);
  });

  it('only re-splits the chunks that overflow when rendered (mixed expansion)', () => {
    const limit = 20;
    // only segments containing "BIG" expand (3x); the rest measure as identity.
    const measure = (s: string) => (s.includes('BIG') ? s.length * 3 : s.length);
    const text = 'aaaa\nbbbb\nBIG BIG BIG BIG BIG BIG\ncccc dddd';
    const chunks = splitByMeasure(text, limit, measure);
    for (const c of chunks) expect(measure(c)).toBeLessThanOrEqual(limit);
  });

  it('converges even when the measure expands heavily (no overflow left behind)', () => {
    const text = words(200);
    const limit = 50;
    const measure = (s: string) => s.length * 5; // extreme expansion
    const chunks = splitByMeasure(text, limit, measure);
    for (const c of chunks) expect(measure(c)).toBeLessThanOrEqual(limit);
  });
});
