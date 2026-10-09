import { describe, expect, it } from 'vitest';
import type { CreateElicitationRequest, SessionUpdate } from '@agentclientprotocol/sdk';
import { buildReverseHint, parseFormElicitation, translateUpdate, type TurnState } from './agent-acp.js';

/** Recording TurnState: capture handler calls as an event string for order assertions. */
function recorder(): { st: TurnState; events: string[]; commands: unknown[] } {
  const events: string[] = [];
  const commands: unknown[] = [];
  const st: TurnState = {
    handlers: {
      onText: (d) => events.push(`text:${d}`),
      onToolStart: (e) => events.push(`start:${e.name}|${e.inputPreview}`),
      onToolFinish: (e) => events.push(`finish:${e.name}|${e.ok}`),
      onSegmentBreak: () => events.push('seg'),
      onAvailableCommands: (c) => commands.push(c),
    },
    lastSegment: 'none',
    toolLedger: new Map(),
    toolIndexSeq: 0,
  };
  return { st, events, commands };
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

describe('parseFormElicitation (agent asks the user, ACP elicitation/create)', () => {
  /**
   * Captured live from claude-agent-acp on 2026-09-11 by advertising
   * `clientCapabilities.elicitation.form` and prompting "MySQL or Postgres? ask me first".
   * Kept verbatim (Chinese text and all) because the field layout — `question_<n>` +
   * `question_<n>_custom`, `oneOf` of `{const,title,description}`, question text in `message`
   * rather than in the property — is what the parser reads, and a hand-written fixture would
   * have quietly encoded a guess about it. Re-checked against 0.81.2's
   * `askUserQuestionsToCreateRequest`, which still builds this exact layout.
   */
  const REAL: CreateElicitationRequest = {
    mode: 'form',
    sessionId: '429f5c2d-f046-4c24-a700-a636ddd5b674',
    toolCallId: 'toolu_01Gt6JuHbhuaX3BRYAh1Gpps',
    message: '这个项目用哪个数据库？',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: '数据库',
          oneOf: [
            { const: 'PostgreSQL', title: 'PostgreSQL', description: '你现有基础设施已经在跑 postgresql15 / pgvector。' },
            { const: 'MySQL', title: 'MySQL', description: '生态广泛，但当前没有现成实例。' },
            { const: '先不定，等我看完项目', title: '先不定，等我看完项目' },
          ],
        },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          description: 'Type your own answer instead of choosing an option above (optional).',
        },
      },
    },
  } as unknown as CreateElicitationRequest;

  it('reads one round out of the real single-question payload', () => {
    const e = parseFormElicitation(REAL)!;
    expect(e.message).toBe('这个项目用哪个数据库？');
    expect(e.questions).toHaveLength(1); // the `_custom` free-text box is not a round
    const q = e.questions[0]!;
    expect(q.key).toBe('question_0');
    // Single-question forms leave `description` unset, so the prompt comes from `message`.
    expect(q.prompt).toBe('这个项目用哪个数据库？');
    expect(q.multi).toBe(false);
    expect(q.options.map((o) => o.value)).toEqual(['PostgreSQL', 'MySQL', '先不定，等我看完项目']);
  });

  it("keeps each option's reasoning, which is why buttons beat prose", () => {
    const opts = parseFormElicitation(REAL)!.questions[0]!.options;
    expect(opts[0]!.description).toContain('pgvector');
    expect(opts[2]!.description).toBeUndefined(); // absent, not empty string
  });

  it('carries the per-question text when a form asks several things', () => {
    const e = parseFormElicitation({
      mode: 'form',
      sessionId: 's',
      message: 'Please answer the following questions.',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: { type: 'string', description: 'Which database?', oneOf: [{ const: 'pg', title: 'Postgres' }] },
          question_1: { type: 'array', description: 'Which regions?', items: { anyOf: [{ const: 'eu', title: 'EU' }] } },
        },
      },
    } as unknown as CreateElicitationRequest)!;
    expect(e.questions.map((q) => q.prompt)).toEqual(['Which database?', 'Which regions?']);
    expect(e.questions.map((q) => q.multi)).toEqual([false, true]);
    // `title` is display, `const` is the answer — an MCP server may make them differ.
    expect(e.questions[0]!.options[0]).toEqual({ label: 'Postgres', value: 'pg' });
  });

  it('returns null for what it cannot put in front of a user', () => {
    // url mode: nothing to render as buttons, and no answer to correlate back.
    expect(parseFormElicitation({ mode: 'url', sessionId: 's', message: 'go here', elicitationId: 'e', url: 'https://x' } as unknown as CreateElicitationRequest)).toBeNull();
    // An option with no `const` has no value to send back, so its question has no options left.
    expect(
      parseFormElicitation({
        mode: 'form', sessionId: 's', message: 'pick',
        requestedSchema: { type: 'object', properties: { question_0: { type: 'string', oneOf: [{ title: 'no const here' }] } } },
      } as unknown as CreateElicitationRequest)
    ).toBeNull();
    // A form with only the free-text box: nothing tappable.
    expect(
      parseFormElicitation({
        mode: 'form', sessionId: 's', message: 'pick',
        requestedSchema: { type: 'object', properties: { question_0_custom: { type: 'string', title: 'Other' } } },
      } as unknown as CreateElicitationRequest)
    ).toBeNull();
  });
});

describe('buildReverseHint: the ask CLI is the fallback, not a rival', () => {
  it('claude asks through its own tool, so its hint leaves `ask` out', () => {
    const hint = buildReverseHint('claude');
    expect(hint).not.toContain('agent-anywhere ask');
    expect(hint).toContain('send-file'); // everything else is still advertised
  });

  it('harnesses that send no elicitation keep `ask` as their only way to show buttons', () => {
    for (const h of ['opencode', 'codex', 'gemini', 'custom'] as const) {
      expect(buildReverseHint(h)).toContain('agent-anywhere ask');
    }
  });
});
