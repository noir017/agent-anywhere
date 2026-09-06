import { describe, expect, it } from 'vitest';
import {
  buildAgyArgs,
  consumeNdJsonLines,
  createAgyAgentFactory,
  parseAgyModelsOutput,
  toolLabel,
  translateAgyEvent,
  type AgyEvent,
  type AgyTurnState,
} from './agent-agy.js';
import { buildInputPreview } from './agent-common.js';
import { AgentDefSchema, type Config } from '../config/schema.js';

/**
 * Every event fixture here is a verbatim shape captured from a real `agy 1.1.22` run
 * (`--input-format=stream-json --output-format=stream-json`), so these tests pin the actual wire
 * format rather than an assumed one.
 */

/** Recording TurnState: capture handler calls as an event string for order assertions. */
function recorder(): { st: AgyTurnState; events: string[] } {
  const events: string[] = [];
  const st: AgyTurnState = {
    handlers: {
      onText: (d) => events.push(`text:${d}`),
      onToolStart: (e) => events.push(`start:${e.name}|${e.inputPreview}`),
      onToolFinish: (e) => events.push(`finish:${e.name}|${e.ok}|${e.durationMs}`),
      onSegmentBreak: () => events.push('seg'),
      onAvailableCommands: () => events.push('cmds'),
    },
    lastSegment: 'none',
    toolLedger: new Map(),
    toolIndexSeq: 0,
  };
  return { st, events };
}

const feed = (st: AgyTurnState, u: unknown): boolean => translateAgyEvent(u as AgyEvent, st);

const def = (over: Record<string, unknown> = {}) =>
  AgentDefSchema.parse({ id: 'a', harness: 'agy', ...over });

describe('translateAgyEvent — text streaming', () => {
  it('text_delta is incremental: each delta is pushed through untouched', () => {
    const { st, events } = recorder();
    // Real capture: a long reply arrives as several ACTIVE frames then a final DONE frame.
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'The ocean is ' } });
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'vast and ' } });
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'living.\n' } });
    expect(events).toEqual(['text:The ocean is ', 'text:vast and ', 'text:living.\n']);
    // Concatenation must reproduce the full reply (deltas, not cumulative snapshots).
    expect(events.map((e) => e.slice('text:'.length)).join('')).toBe('The ocean is vast and living.\n');
  });

  it('bookkeeping frames (user_input / checkpoint) render nothing', () => {
    const { st, events } = recorder();
    feed(st, { event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } });
    feed(st, { event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'checkpoint' } });
    expect(events).toEqual([]);
  });

  it('an agent_response frame with no text_delta (usage-only DONE) renders nothing', () => {
    const { st, events } = recorder();
    // Captured verbatim: a tool-using turn emits a DONE agent_response carrying only usage.
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 4.36 } });
    expect(events).toEqual([]);
  });
});

describe('translateAgyEvent — tool state machine', () => {
  it('ACTIVE opens the bubble, DONE closes it with agy-reported duration', () => {
    const { st, events } = recorder();
    feed(st, {
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello-from-tool' } },
      },
    });
    expect(events).toEqual(['start:Bash|echo hello-from-tool']);
    feed(st, {
      event: 'step_update',
      step_update: {
        step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.110969865,
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello-from-tool' }, output: 'hello-from-tool\r\n' },
      },
    });
    // 0.110969865s -> 111ms (the bubble shows agy's own timing, not wall clock).
    expect(events).toEqual(['start:Bash|echo hello-from-tool', 'finish:Bash|true|111']);
  });

  it('tool_info.error marks the finish as failed', () => {
    const { st, events } = recorder();
    const info = { name: 'run_command', parameters: { CommandLine: 'cat /nope' }, error: { type: 'EXEC', message: 'No such file' } };
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: info } });
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', duration_seconds: 0.05, tool_info: info } });
    expect(events).toEqual(['start:Bash|cat /nope', 'finish:Bash|false|50']);
  });

  it('text -> tool and tool -> text boundaries each emit one onSegmentBreak', () => {
    const { st, events } = recorder();
    feed(st, { event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: "I'll run it" } });
    feed(st, {
      event: 'step_update',
      step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } },
    });
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', duration_seconds: 0.1, tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } });
    feed(st, { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.' } });
    expect(events).toEqual([
      "text:I'll run it",
      'seg',
      'start:Bash|ls',
      'finish:Bash|true|100',
      'seg',
      'text:Done.',
    ]);
  });

  it('DONE without a preceding ACTIVE still renders a start then a finish', () => {
    const { st, events } = recorder();
    feed(st, {
      event: 'step_update',
      step_update: { step_index: 2, state: 'DONE', step_type: 'tool', duration_seconds: 0.2, tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/x.txt' } } },
    });
    expect(events).toEqual(['start:Read|/tmp/x.txt', 'finish:Read|true|200']);
  });

  it('distinct step_index values get distinct bubble indices', () => {
    const { st } = recorder();
    const seen: Array<number | undefined> = [];
    st.handlers.onToolStart = (e) => seen.push(e.index);
    feed(st, { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/a' } } } });
    feed(st, { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'grep_search', parameters: { Query: 'beta' } } } });
    expect(seen).toEqual([0, 1]);
  });

  it('a repeated ACTIVE frame for the same step does not open a second bubble', () => {
    const { st, events } = recorder();
    const u = { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_info: { name: 'run_command', parameters: { CommandLine: 'ls' } } } };
    feed(st, u);
    feed(st, u);
    expect(events).toEqual(['start:Bash|ls']);
  });
});

describe('translateAgyEvent — turn termination', () => {
  it('result SUCCESS ends the turn', () => {
    const { st } = recorder();
    expect(feed(st, { event: 'result', result: { status: 'SUCCESS', response: 'apple\n' } })).toBe(true);
  });

  it('step_update frames do not end the turn', () => {
    const { st } = recorder();
    expect(feed(st, { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'x' } })).toBe(false);
  });

  it('result ERROR throws with agy\'s own reason (surfaced to the channel as ❌)', () => {
    const { st } = recorder();
    expect(() =>
      feed(st, { event: 'result', result: { status: 'ERROR', response: '', error: 'timeout waiting for response' } })
    ).toThrow(/status ERROR: timeout waiting for response/);
  });

  it('a slash command intercepted by the CLI surfaces its explanation verbatim', () => {
    // This is exactly why buildAgyArgs passes --disable-slash-commands; if it ever regresses, the
    // operator should still see agy's own explanation rather than a bare failure.
    const { st } = recorder();
    expect(() =>
      feed(st, {
        event: 'result',
        result: { status: 'ERROR', error: '/model is answered by the CLI itself and is unavailable with --input-format stream-json' },
      })
    ).toThrow(/answered by the CLI itself/);
  });

  it('a missing status is treated as success (absent field means no failure reported)', () => {
    const { st } = recorder();
    expect(feed(st, { event: 'result', result: { response: 'ok' } })).toBe(true);
  });

  it('the trailing result a SIGINT-ed agy flushes is reported as an error, so it must never reach the next turn', () => {
    // Regression guard for a bug found during live verification: after abort() the dying child
    // emits `status:ERROR, "stream input cancelled: context canceled"`. Translation correctly calls
    // that a failure, so the session must detach the child on abort (see abort(): resetHandles +
    // handleLine's `proc !== from` drop) — otherwise this frame fails the FOLLOWING turn.
    const { st } = recorder();
    expect(() =>
      feed(st, { event: 'result', result: { status: 'ERROR', error: 'stream input cancelled: context canceled' } })
    ).toThrow(/stream input cancelled/);
  });
});

describe('buildInputPreview — agy PascalCase parameters', () => {
  // agy names its tool parameters in PascalCase, unlike the snake_case ACP harnesses. Without these
  // keys the preview degrades to a full JSON dump of the parameter object.
  it.each([
    [{ CommandLine: 'echo hi', Cwd: '/tmp', WaitMsBeforeAsync: 5000, toolAction: 'Running' }, 'echo hi'],
    [{ AbsolutePath: '/tmp/sample.txt' }, '/tmp/sample.txt'],
    [{ DirectoryPath: '/tmp/agyprobe' }, '/tmp/agyprobe'],
    [{ Query: 'beta', SearchPath: '/tmp' }, 'beta'],
  ])('%o -> %s', (params, expected) => {
    expect(buildInputPreview(params)).toBe(expected);
  });

  it('still prefers the meaningful key over incidental ones agy also sends', () => {
    // Cwd/WaitMsBeforeAsync/toolAction must never win the preview over CommandLine.
    expect(buildInputPreview({ Cwd: '/tmp', toolAction: 'Running echo command', CommandLine: 'echo x' })).toBe('echo x');
  });

  it('keeps working for the snake_case ACP harnesses', () => {
    expect(buildInputPreview({ command: 'gh pr list' })).toBe('gh pr list');
    expect(buildInputPreview({ file_path: 'src/x.ts' })).toBe('src/x.ts');
  });

  it('an unrecognized parameter shape falls back to JSON, and an empty one to ""', () => {
    expect(buildInputPreview({ Unknown: 1 })).toBe('{"Unknown":1}');
    expect(buildInputPreview({})).toBe('');
  });
});

describe('toolLabel', () => {
  it('maps agy tool names onto the default emojiMap keys', () => {
    expect(toolLabel('run_command')).toBe('Bash');
    expect(toolLabel('view_file')).toBe('Read');
    expect(toolLabel('write_to_file')).toBe('Write');
    expect(toolLabel('replace_file_content')).toBe('Edit');
    expect(toolLabel('grep_search')).toBe('Grep');
    expect(toolLabel('find_by_name')).toBe('Glob');
    expect(toolLabel('read_url_content')).toBe('WebFetch');
    expect(toolLabel('search_web')).toBe('WebSearch');
    expect(toolLabel('invoke_subagent')).toBe('Task');
  });

  it('keeps an unmapped tool name (agy ships many specialized ones) and truncates long ones', () => {
    expect(toolLabel('capture_browser_screenshot')).toBe('capture_browser_screenshot');
    expect(toolLabel('a'.repeat(40))).toHaveLength(32);
    expect(toolLabel(undefined)).toBe('Tool');
  });
});

describe('buildAgyArgs', () => {
  it('sets the flags each measured agy behavior requires', () => {
    const args = buildAgyArgs(def(), '/work');
    expect(args).toContain('--input-format=stream-json');
    expect(args).toContain('--output-format=stream-json');
    // Default --print-timeout is 5m and kills long turns; the daemon's own watchdog bounds them.
    expect(args.some((a) => a.startsWith('--print-timeout='))).toBe(true);
    // Without this, any `/…` message makes agy exit and the session is lost.
    expect(args).toContain('--disable-slash-commands');
    // The daemon is a headless client: it auto-approves tools for every harness.
    expect(args).toContain('--dangerously-skip-permissions');
    // Trust the agent's own cwd, else file writes are redirected to agy's scratch dir.
    expect(args).toContain('--add-dir=/work');
  });

  it('ends with `-p=` — Go flag parsing makes a bare `-p` swallow the next argument', () => {
    const args = buildAgyArgs(def({ args: ['--effort=high'] }), '/work');
    expect(args[args.length - 1]).toBe('-p=');
  });

  it('appends def.args after the presets so a user can override any default (Go is last-wins)', () => {
    const args = buildAgyArgs(def({ args: ['--disable-slash-commands=false'] }), '/work');
    expect(args.indexOf('--disable-slash-commands=false')).toBeGreaterThan(args.indexOf('--disable-slash-commands'));
  });

  it('passes the model only when configured', () => {
    expect(buildAgyArgs(def({ model: 'claude-sonnet-4-6' }), '/w')).toContain('--model=claude-sonnet-4-6');
    expect(buildAgyArgs(def(), '/w').some((a) => a.startsWith('--model='))).toBe(false);
  });

  it('prefers modelOverride over def.model when provided', () => {
    expect(buildAgyArgs(def({ model: 'claude-sonnet-4-6' }), '/w', undefined, 'gemini-3.8-flash-high')).toContain(
      '--model=gemini-3.8-flash-high'
    );
    expect(buildAgyArgs(def(), '/w', undefined, 'gemini-3.8-flash-high')).toContain(
      '--model=gemini-3.8-flash-high'
    );
  });

  it('resumes a prior conversation only when one was persisted', () => {
    expect(buildAgyArgs(def(), '/w', 'abc-123')).toContain('--conversation=abc-123');
    expect(buildAgyArgs(def(), '/w').some((a) => a.startsWith('--conversation='))).toBe(false);
  });
});

describe('consumeNdJsonLines', () => {
  it('emits complete frames and carries the trailing partial line over', () => {
    const seen: string[] = [];
    const rest = consumeNdJsonLines('{"a":1}\n{"b":2}\n{"c":', (l) => seen.push(l));
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it('reassembles a frame split across chunks', () => {
    const seen: string[] = [];
    const rest = consumeNdJsonLines(consumeNdJsonLines('{"a":', (l) => seen.push(l)) + '1}\n', (l) => seen.push(l));
    expect(seen).toEqual(['{"a":1}']);
    expect(rest).toBe('');
  });

  it('skips blank lines', () => {
    const seen: string[] = [];
    consumeNdJsonLines('\n\n{"a":1}\n\n', (l) => seen.push(l));
    expect(seen).toEqual(['{"a":1}']);
  });
});

describe('parseAgyModelsOutput', () => {
  it('parses tab-separated model ID and display name', () => {
    const raw = [
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n');
    expect(parseAgyModelsOutput(raw)).toEqual([
      { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ]);
  });

  it('parses verbatim stdout captured from a real `agy models` run', () => {
    // Captured 2026-09 from the logged-in CLI (same shape as the AgyEvent fixtures above).
    // The "Fetching available models..." spinner goes to stderr, so stdout is pure TSV.
    const raw = [
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
      'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
      'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
      'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
      'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
      'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n');
    const models = parseAgyModelsOutput(raw);
    expect(models).toHaveLength(14);
    expect(models[0]).toEqual({ value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' });
    expect(models[13]).toEqual({ value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' });
  });

  it('falls back to value when line contains no tab or has empty display name', () => {
    const raw = 'model-one\nmodel-two\t\nmodel-three\tModel Three';
    expect(parseAgyModelsOutput(raw)).toEqual([
      { value: 'model-one', name: 'model-one' },
      { value: 'model-two', name: 'model-two' },
      { value: 'model-three', name: 'Model Three' },
    ]);
  });

  it('handles empty or whitespace-only output', () => {
    expect(parseAgyModelsOutput('')).toEqual([]);
    expect(parseAgyModelsOutput('  \n\n  \t  \n  ')).toEqual([]);
  });
});

describe('createAgyAgentFactory — model selector and switching', () => {
  const SAMPLE_MODELS = [
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  ];

  const cfg = {
    agents: [
      def({ id: 'agy-main', harness: 'agy', model: 'gemini-3.8-flash-high' }),
    ],
  } as unknown as Config;

  it('returns modelSelector with options from fetcher and initial current from def.model', async () => {
    const fetcher = async () => SAMPLE_MODELS;
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, fetcher);
    // Allow eager fetch to resolve
    await Promise.resolve();

    const session = factory.getOrCreate('conv-1', 'agy-main');
    const selector = session.modelSelector?.();
    expect(selector).toBeDefined();
    expect(selector?.options).toEqual(SAMPLE_MODELS);
    expect(selector?.current).toBe('gemini-3.8-flash-high');
  });

  it('setModel records preference and updates modelSelector current', async () => {
    const fetcher = async () => SAMPLE_MODELS;
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, fetcher);
    await Promise.resolve();

    const session = factory.getOrCreate('conv-1', 'agy-main');
    expect(session.setModel).toBeDefined();
    const res = await session.setModel!('claude-sonnet-4-6');
    expect(res).toBe('claude-sonnet-4-6');

    // modelSelector now reports the chosen model as current
    const selector = session.modelSelector?.();
    expect(selector?.current).toBe('claude-sonnet-4-6');
  });

  it('modelSelector returns undefined if model fetcher returns empty or fails', async () => {
    const failingFetcher = async () => {
      throw new Error('command not found: agy');
    };
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, failingFetcher);
    await Promise.resolve();

    const session = factory.getOrCreate('conv-1', 'agy-main');
    expect(session.modelSelector?.()).toBeUndefined();
  });

  it('peek and dispose manage factory sessions', async () => {
    const factory = createAgyAgentFactory(cfg, '/tmp/test.sock', undefined, async () => []);
    expect(factory.peek('conv-1')).toBeUndefined();

    const s = factory.getOrCreate('conv-1', 'agy-main');
    expect(factory.peek('conv-1')).toBe(s);

    factory.dispose('conv-1');
    expect(factory.peek('conv-1')).toBeUndefined();
  });
});
