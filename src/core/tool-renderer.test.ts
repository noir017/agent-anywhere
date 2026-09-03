import { describe, it, expect } from 'vitest';
import type { MessageRef, ToolEvent, ToolFinishEvent } from '../types.js';
import {
  ToolRenderer,
  formatDuration,
  type BubbleSink,
  type ToolRendererOptions,
} from './tool-renderer.js';

/** Mock BubbleSink recording sendBubble / editBubble calls. */
function makeSink(opts: { withEdit: boolean }) {
  const sends: string[] = [];
  const edits: Array<{ ref: MessageRef; text: string }> = [];
  let counter = 0;

  const sink: BubbleSink = {
    async sendBubble(text: string): Promise<MessageRef> {
      sends.push(text);
      counter += 1;
      return { address: { channel: 'c' }, messageId: `m${counter}` };
    },
  };
  if (opts.withEdit) {
    sink.editBubble = async (ref: MessageRef, text: string): Promise<void> => {
      edits.push({ ref, text });
    };
  }
  return { sink, sends, edits };
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
    const { sink, sends, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    expect(await r.onToolStart(start('Read', 'src/a.ts'))).toBe(true);
    expect(await r.onToolStart(start('Edit', 'src/b.ts'))).toBe(true);

    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
    expect(sends[0]).toBe('📖 Read: "src/a.ts"');
    expect(sends[1]).toBe('✏️ Edit: "src/b.ts"');
  });

  it('onToolFinish is a safe no-op under separate', async () => {
    const { sink, sends, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate' }), sink);

    await r.onToolStart(start('Read', 'src/a.ts', 0));
    await r.onToolFinish(finish('Read', true, 1200, 0));

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(0);
  });
});

describe('accumulate mode', () => {
  it('two starts → one sendBubble + one editBubble, bubble holds two lines', async () => {
    const { sink, sends, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    expect(await r.onToolStart(start('Read', 'src/a.ts', 0))).toBe(true);
    expect(await r.onToolStart(start('Edit', 'src/b.ts', 1))).toBe(false);

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);

    const finalText = edits[edits.length - 1]!.text;
    expect(finalText).toBe('📖 Read: "src/a.ts"\n✏️ Edit: "src/b.ts"');
    expect(finalText.split('\n')).toHaveLength(2);
  });

  it('onToolFinish marks the matching line with ✓ and duration', async () => {
    const { sink, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    await r.onToolStart(start('Read', 'src/a.ts', 0));
    await r.onToolStart(start('Edit', 'src/b.ts', 1));
    await r.onToolFinish(finish('Read', true, 1200, 0));

    const text = edits[edits.length - 1]!.text;
    const readLine = text.split('\n').find((l) => l.startsWith('📖'))!;
    expect(readLine).toContain('✓');
    expect(readLine).toContain('1.2s');
    expect(readLine).toBe('📖 Read: "src/a.ts" ✓ 1.2s');
  });

  it('ok=false → ✗', async () => {
    const { sink, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    await r.onToolStart(start('Bash', 'ls', 0));
    await r.onToolFinish(finish('Bash', false, 832, 0));

    const text = edits[edits.length - 1]!.text;
    expect(text).toContain('✗');
    expect(text).toContain('832ms');
    expect(text).toBe('💻 Bash: "ls" ✗ 832ms');
  });

  it('with no index, locates by appearance order / same name', async () => {
    const { sink, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'all' }), sink);

    await r.onToolStart(start('Read', 'src/a.ts'));
    await r.onToolStart(start('Read', 'src/b.ts'));
    // No index → hits the first unfinished line with the same name.
    await r.onToolFinish(finish('Read', true, 500));

    const lines = edits[edits.length - 1]!.text.split('\n');
    expect(lines[0]).toBe('📖 Read: "src/a.ts" ✓ 500ms');
    expect(lines[1]).toBe('📖 Read: "src/b.ts"');
  });

  it('under verbose, JSON is attached below the line (only once)', async () => {
    const { sink, sends } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'verbose' }), sink);

    await r.onToolStart({ name: 'Read', inputPreview: 'src/a.ts', input: { path: 'src/a.ts' }, index: 0 });

    expect(sends[0]).toContain('```json');
    expect(sends[0]).toContain('"path": "src/a.ts"');
  });

  it('with no sink.editBubble, degrades to separate (a new bubble each time)', async () => {
    const { sink, sends, edits } = makeSink({ withEdit: false });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    expect(await r.onToolStart(start('Read', 'src/a.ts', 0))).toBe(true);
    expect(await r.onToolStart(start('Edit', 'src/b.ts', 1))).toBe(true);

    expect(sends).toHaveLength(2);
    expect(edits).toHaveLength(0);
  });

  it('after resetSegment the next segment starts a new bubble', async () => {
    const { sink, sends } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate' }), sink);

    await r.onToolStart(start('Read', 'src/a.ts', 0));
    r.resetSegment();
    expect(await r.onToolStart(start('Edit', 'src/b.ts', 0))).toBe(true);

    expect(sends).toHaveLength(2);
    // The second segment's bubble holds only the new line, not the prior segment.
    expect(sends[1]).toBe('✏️ Edit: "src/b.ts"');
  });
});

describe('new dedupe', () => {
  it('separate: consecutive same name sends only one', async () => {
    const { sink, sends } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'separate', mode: 'new' }), sink);

    expect(await r.onToolStart(start('Read', 'src/a.ts'))).toBe(true);
    expect(await r.onToolStart(start('Read', 'src/b.ts'))).toBe(false);
    expect(await r.onToolStart(start('Edit', 'src/c.ts'))).toBe(true);

    expect(sends).toHaveLength(2);
  });

  it('accumulate: consecutive same name does not enter the line set', async () => {
    const { sink, sends, edits } = makeSink({ withEdit: true });
    const r = new ToolRenderer(makeOpts({ grouping: 'accumulate', mode: 'new' }), sink);

    expect(await r.onToolStart(start('Read', 'src/a.ts', 0))).toBe(true);
    expect(await r.onToolStart(start('Read', 'src/b.ts', 1))).toBe(false); // deduped
    expect(await r.onToolStart(start('Edit', 'src/c.ts', 2))).toBe(false); // added to line + edit

    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    const text = edits[edits.length - 1]!.text;
    expect(text).toBe('📖 Read: "src/a.ts"\n✏️ Edit: "src/c.ts"');
  });
});
