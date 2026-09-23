import { describe, expect, it } from 'vitest';
import { buildHarnessEnv, buildReverseHint } from './agent-common.js';

describe('buildHarnessEnv', () => {
  it('strips nested Claude session markers but keeps the configured CLI executable', () => {
    const previous = {
      claudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
      claudeCodeEntrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      claudeCode: process.env.CLAUDECODE,
    };
    process.env.CLAUDE_CODE_EXECUTABLE = '/usr/bin/claude';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDECODE = '1';

    try {
      const env = buildHarnessEnv({ id: 'cc', harness: 'claude', args: [], env: {} });

      expect(env.CLAUDE_CODE_EXECUTABLE).toBe('/usr/bin/claude');
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined();
    } finally {
      if (previous.claudeCodeExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
      else process.env.CLAUDE_CODE_EXECUTABLE = previous.claudeCodeExecutable;
      if (previous.claudeCodeEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = previous.claudeCodeEntrypoint;
      if (previous.claudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previous.claudeCode;
    }
  });
});

/**
 * What the model is told about running inside the gateway, before it has read the user's message.
 *
 * The whole point of this hint is that it is nearly empty: it used to be nine commands and ~350
 * tokens of chat-bot manual in the first text block of every session, which framed the work as
 * "operate a chat client" before the work was visible. These pin the two things that survived and
 * the reason each did.
 */
describe('buildReverseHint', () => {
  it('tells every harness about send-file, the one thing text cannot do', () => {
    for (const harness of ['claude', 'opencode', 'dsh', 'agy', 'custom'] as const) {
      expect(buildReverseHint(harness)).toContain('send-file');
    }
  });

  it('stays a single command on claude, which asks with its own tool', () => {
    const hint = buildReverseHint('claude');
    // claude sends ACP `elicitation/create`, so advertising the CLI would offer a second, worse
    // way to do the same thing.
    expect(hint).not.toContain('agent-anywhere ask');
    expect(hint.split('\n').filter((l) => l.trim().startsWith('- '))).toHaveLength(1);
  });

  it('keeps `ask` for harnesses that cannot ask over ACP', () => {
    // Probed 2026-09-11: neither sends any reverse request, so without this hint their models can
    // only ask in prose and the user loses buttons entirely.
    for (const harness of ['opencode', 'dsh'] as const) {
      expect(buildReverseHint(harness)).toContain('agent-anywhere ask');
    }
  });

  it('treats an unprobed harness as unable to ask (cheap to be wrong, costly the other way)', () => {
    for (const harness of ['gemini', 'codex', 'agy', 'custom'] as const) {
      expect(buildReverseHint(harness)).toContain('agent-anywhere ask');
    }
    expect(buildReverseHint(undefined)).toContain('agent-anywhere ask');
  });

  it('never mentions the commands that duplicate what the gateway already does', () => {
    for (const harness of ['claude', 'opencode'] as const) {
      const hint = buildReverseHint(harness);
      for (const gone of ['send-message', 'reply', 'edit-message', 'react', 'delete', 'fetch-messages', 'create-thread']) {
        expect(hint).not.toContain(`agent-anywhere ${gone}`);
      }
    }
  });
});
