import { describe, expect, it } from 'vitest';
import type { SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk';
import { liveModelName, translateUpdate, type TurnState } from './agent-acp.js';
import type { AgentUsage } from './agent.js';

/** Recording TurnState: capture handler calls as an event string for order assertions. */
function recorder(): {
  st: TurnState;
  events: string[];
  commands: unknown[];
  usage: AgentUsage[];
  models: string[];
  configOptions: Array<SessionConfigOption[] | null | undefined>;
} {
  const events: string[] = [];
  const commands: unknown[] = [];
  const usage: AgentUsage[] = [];
  const models: string[] = [];
  const configOptions: Array<SessionConfigOption[] | null | undefined> = [];
  const st: TurnState = {
    handlers: {
      onText: (d) => events.push(`text:${d}`),
      onToolStart: (e) => events.push(`start:${e.name}|${e.inputPreview}`),
      onToolFinish: (e) => events.push(`finish:${e.name}|${e.ok}`),
      onSegmentBreak: () => events.push('seg'),
      onAvailableCommands: (c) => commands.push(c),
      onUsage: (u) => usage.push(u),
      onModel: (m) => models.push(m),
    },
    lastSegment: 'none',
    toolLedger: new Map(),
    toolIndexSeq: 0,
    onConfigOptions: (o) => configOptions.push(o),
  };
  return { st, events, commands, usage, models, configOptions };
}

const feed = (st: TurnState, u: unknown) => translateUpdate(u as SessionUpdate, st);

describe('translateUpdate tool state machine (ACP generic)', () => {
  it('params arrive late: pending empty input not rendered, then rendered once with kind short name + truncated params', () => {
    const { st, events } = recorder();
    // 1) first pending, empty input, placeholder title → not rendered
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', kind: 'execute', rawInput: {}, status: 'pending' });
    expect(events).toEqual([]);
    // 2) params streamed (same id overwrites) → render: name from kind (execute→Bash), preview from rawInput.command
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`gh ...`', kind: 'execute', rawInput: { command: 'gh ...' }, status: 'pending' });
    expect(events).toEqual(['start:Bash|gh ...']);
    // 3) completed
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(events).toEqual(['start:Bash|gh ...', 'finish:Bash|true']);
  });

  it('always-empty input but status advances: still renders, preview degrades to title (does not show "{}")', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', kind: 'execute', rawInput: {}, status: 'pending' });
    expect(events).toEqual([]);
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' });
    expect(events).toEqual(['start:Bash|Terminal']); // empty rawInput → preview degrades to title
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    expect(events).toEqual(['start:Bash|Terminal', 'finish:Bash|true']);
  });

  it('terminal arrives first (no in_progress): synthesize one start then finish', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read x', kind: 'read', rawInput: { file_path: 'src/x.ts' }, status: 'completed' });
    expect(events).toEqual(['start:Read|src/x.ts', 'finish:Read|true']);
  });

  it('failed → onToolFinish ok=false', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'boom' }, status: 'in_progress' });
    feed(st, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
    expect(events).toEqual(['start:Bash|boom', 'finish:Bash|false']);
  });

  it('text→tool boundary triggers onSegmentBreak once', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll run it" } });
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'ls' }, status: 'in_progress' });
    expect(events).toEqual(["text:I'll run it", 'seg', 'start:Bash|ls']);
  });

  it('falls back to the truncated title (backticks stripped) when there is no kind', () => {
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'tool_call', toolCallId: 't1', title: '`do-thing`', rawInput: { x: 1 }, status: 'in_progress' });
    // no kind → name uses stripCode(title)='do-thing'; preview from rawInput summary
    expect(events[0]).toBe('start:do-thing|{"x":1}');
  });

  it('available_commands_update normalizes to {name,description,hint} for onAvailableCommands', () => {
    const { st, commands, events } = recorder();
    feed(st, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'create_plan', description: 'Create a plan', input: { hint: 'Describe the goal' } },
        { name: 'review', description: 'Review' }, // no input → hint undefined
      ],
    });
    expect(events).toEqual([]); // doesn't pollute the text/tool event stream
    expect(commands).toEqual([
      [
        { name: 'create_plan', description: 'Create a plan', hint: 'Describe the goal' },
        { name: 'review', description: 'Review', hint: undefined },
      ],
    ]);
  });
});

/**
 * usage_update → onUsage.
 *
 * These numbers are why the footer can show a real `18k / 1M (2%)`: `used` is the harness's own
 * context tally and `size` the window it learned from the live model. Before this, the update fell
 * into translateUpdate's `default: break` and was silently dropped, which is why the pre-existing
 * `contextPct` footer field could never render.
 */
describe('translateUpdate usage_update (live context numbers)', () => {
  it('forwards used/size to onUsage without touching the text/tool stream', () => {
    const { st, usage, events } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 18_000, size: 1_000_000 });
    expect(usage).toEqual([{ used: 18_000, size: 1_000_000 }]);
    expect(events).toEqual([]);
  });

  it('does not break a text segment: a mid-stream update leaves lastSegment alone', () => {
    // claude-agent-acp emits one usage_update per assistant message, i.e. mid-body. If that counted
    // as a segment the reply would be split into separate bubbles around every update.
    const { st, events } = recorder();
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } });
    feed(st, { sessionUpdate: 'usage_update', used: 1, size: 10 });
    feed(st, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } });
    expect(events).toEqual(['text:a', 'text:b']); // no 'seg' between them
    expect(st.lastSegment).toBe('text');
  });

  it('later snapshots are forwarded in order (the consumer keeps the last)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 100, size: 1_000 });
    feed(st, { sessionUpdate: 'usage_update', used: 250, size: 1_000 });
    expect(usage.map((u) => u.used)).toEqual([100, 250]);
  });

  it('drops a snapshot with a non-positive window instead of forwarding a divide-by-zero', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 100, size: 0 });
    feed(st, { sessionUpdate: 'usage_update', used: 100, size: -1 });
    expect(usage).toEqual([]);
  });

  it('drops a malformed snapshot (missing or non-numeric fields)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 100 });
    feed(st, { sessionUpdate: 'usage_update', size: 1_000 });
    feed(st, { sessionUpdate: 'usage_update', used: '100', size: '1000' });
    expect(usage).toEqual([]);
  });

  it('a zero-token snapshot IS forwarded (a fresh session legitimately reports 0 used)', () => {
    const { st, usage } = recorder();
    feed(st, { sessionUpdate: 'usage_update', used: 0, size: 200_000 });
    expect(usage).toEqual([{ used: 0, size: 200_000 }]);
  });
});

/**
 * The live model name.
 *
 * Needed because config can't answer the question: the `claude` harness takes its model from
 * ANTHROPIC_MODEL (the only source that survives Claude Code rewriting settings.model), so
 * `agents[].model` is empty and the alias (`opus[1m]`) is resolved inside the harness. The session's
 * `model` config option is the only place the concrete model surfaces.
 */
describe('liveModelName (model from ACP session config options)', () => {
  const opts = (o: unknown): SessionConfigOption[] => o as SessionConfigOption[];

  it('prefers the selected option\'s human-readable name', () => {
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'claude-opus-4-5',
            options: [
              { value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' },
              { value: 'claude-opus-4-5', name: 'Opus 4.5' },
            ],
          },
        ]),
      ),
    ).toBe('Opus 4.5');
  });

  it('searches inside grouped options too', () => {
    expect(
      liveModelName(
        opts([
          {
            id: 'model',
            type: 'select',
            name: 'Model',
            currentValue: 'opus-1m',
            options: [
              { group: 'recommended', name: 'Recommended', options: [{ value: 'sonnet', name: 'Sonnet' }] },
              { group: 'long', name: 'Long context', options: [{ value: 'opus-1m', name: 'Opus (1M)' }] },
            ],
          },
        ]),
      ),
    ).toBe('Opus (1M)');
  });

  it('falls back to the raw currentValue when the model is not among the listed options', () => {
    // Real case: an allowlisted-but-unlisted model still reports a currentValue, and that id is
    // more useful than showing nothing.
    expect(
      liveModelName(
        opts([{ id: 'model', type: 'select', name: 'Model', currentValue: 'opus[1m]', options: [] }]),
      ),
    ).toBe('opus[1m]');
  });

  it('ignores the other config options (mode / effort / fast)', () => {
    expect(
      liveModelName(
        opts([
          { id: 'mode', type: 'select', name: 'Mode', currentValue: 'ask', options: [] },
          { id: 'effort', type: 'select', name: 'Effort', currentValue: 'high', options: [] },
          { id: 'model', type: 'select', name: 'Model', currentValue: 'gpt-5', options: [] },
        ]),
      ),
    ).toBe('gpt-5');
  });

  it('returns undefined when there is no model selector at all', () => {
    expect(liveModelName(opts([{ id: 'mode', type: 'select', name: 'Mode', currentValue: 'ask', options: [] }]))).toBeUndefined();
    expect(liveModelName([])).toBeUndefined();
    expect(liveModelName(undefined)).toBeUndefined();
    expect(liveModelName(null)).toBeUndefined();
  });

  it('returns undefined for a boolean option sharing the id, or an empty currentValue', () => {
    expect(liveModelName(opts([{ id: 'model', type: 'boolean', name: 'Model', currentValue: true }]))).toBeUndefined();
    expect(
      liveModelName(opts([{ id: 'model', type: 'select', name: 'Model', currentValue: '', options: [] }])),
    ).toBeUndefined();
  });
});

describe('translateUpdate config_option_update (mid-session model switch)', () => {
  it('reports the newly selected model via onModel', () => {
    const { st, models, events } = recorder();
    feed(st, {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          name: 'Model',
          currentValue: 'claude-sonnet-4-5',
          options: [{ value: 'claude-sonnet-4-5', name: 'Sonnet 4.5' }],
        },
      ],
    });
    expect(models).toEqual(['Sonnet 4.5']);
    expect(events).toEqual([]);
  });

  it('hands the whole option list back to the session, not just the model name', () => {
    // onModel alone kept the FOOTER current while modelSelector() went on reporting the value
    // session/new had reported — so a /model menu opened after a mid-session switch marked the
    // wrong model as current and opened on the wrong page.
    const { st, configOptions } = recorder();
    const options: SessionConfigOption[] = [
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        currentValue: 'newapi/GLM-5.2',
        options: [
          { value: 'newapi/GLM-5.2', name: 'GLM-5.2' },
          { value: 'newapi/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ],
      },
    ];
    feed(st, { sessionUpdate: 'config_option_update', configOptions: options });
    expect(configOptions).toEqual([options]);
  });

  it('stays silent when the update carries no model selector', () => {
    const { st, models } = recorder();
    feed(st, {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'effort', type: 'select', name: 'Effort', currentValue: 'high', options: [] }],
    });
    expect(models).toEqual([]);
  });
});

/**
 * Label choice when the harness's own option names are inconsistent.
 *
 * The option list below is the REAL one captured from claude-agent-acp with ANTHROPIC_MODEL=opus[1m]
 * (currentValue "opus[1m]"). Note the inconsistency: `sonnet[1m]` is labelled "Sonnet 5 (1M context)"
 * but `opus[1m]` is labelled plain "Opus". Reporting the bare name would show a 1M-context session as
 * "Opus" while the footer's context segment simultaneously reads `/ 1M` — so the id wins whenever the
 * name drops a bracketed qualifier.
 */
describe('liveModelName label choice (real claude-agent-acp option list)', () => {
  const REAL_OPTIONS = [
    { value: 'default', name: 'Default (recommended)' },
    { value: 'opus[1m]', name: 'Opus' },
    { value: 'sonnet', name: 'Sonnet' },
    { value: 'sonnet[1m]', name: 'Sonnet 5 (1M context)' },
    { value: 'haiku', name: 'Haiku' },
  ];

  const withCurrent = (currentValue: string): SessionConfigOption[] =>
    [{ id: 'model', type: 'select', name: 'Model', currentValue, options: REAL_OPTIONS }] as SessionConfigOption[];

  it('keeps the id when the name silently drops [1m] (the deployed case)', () => {
    expect(liveModelName(withCurrent('opus[1m]'))).toBe('opus[1m]');
  });

  it('uses the friendly name when it already conveys the 1M qualifier', () => {
    expect(liveModelName(withCurrent('sonnet[1m]'))).toBe('Sonnet 5 (1M context)');
  });

  it('uses the friendly name for ids with no qualifier at all', () => {
    expect(liveModelName(withCurrent('sonnet'))).toBe('Sonnet');
    expect(liveModelName(withCurrent('haiku'))).toBe('Haiku');
    expect(liveModelName(withCurrent('default'))).toBe('Default (recommended)');
  });

  it('a name that spells the qualifier differently still counts as carrying it', () => {
    // "[1m]" vs "1M context" vs "1m" — matching is bracket-insensitive and case-insensitive, so a
    // harness rewording its labels does not silently flip us back to raw ids.
    const opts = (name: string): SessionConfigOption[] =>
      [{ id: 'model', type: 'select', name: 'Model', currentValue: 'opus[1m]', options: [{ value: 'opus[1m]', name }] }] as SessionConfigOption[];
    expect(liveModelName(opts('Opus (1M)'))).toBe('Opus (1M)');
    expect(liveModelName(opts('Opus 1m'))).toBe('Opus 1m');
    expect(liveModelName(opts('Opus [1M] context'))).toBe('Opus [1M] context');
  });

  it('a bare version number in the name does not count as a context qualifier', () => {
    // "Opus 5" says which model, not which context window — it must not satisfy [1m].
    const opts = [{ id: 'model', type: 'select', name: 'Model', currentValue: 'opus[1m]', options: [{ value: 'opus[1m]', name: 'Opus 5' }] }] as SessionConfigOption[];
    expect(liveModelName(opts)).toBe('opus[1m]');
  });
});
