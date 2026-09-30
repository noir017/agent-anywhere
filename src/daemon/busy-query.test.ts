import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentUsage } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * `/usage` and `/context` asked while the conversation is busy.
 *
 * The bug, seen live on 2026-09-30: a cc turn was running typecheck + the full test suite when the
 * user sent `/usage`. The command was forwarded like any other message, so interruptOnNewMessage
 * cancelled the turn mid-Bash; Claude Code then answered `/usage` locally in under 50ms, and the
 * work stayed stopped until the user noticed and typed "继续".
 *
 * So a busy conversation gets the gateway's own snapshot and the turn is left alone. What these
 * tests pin is the ROUTING decision — never forwarded, never interrupting — plus the two things the
 * answer must carry: numbers the harness really reported, and the note saying whose answer it is.
 */

function config(defaultAgent: string, window: { mergeWindowMs: number; maxMergeWindowMs: number }): Config {
  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'cx', harness: 'codex' },
      { id: 'oc', harness: 'opencode' },
    ],
    routing: { default: defaultAgent },
  });
  // `inbound` is part of the frozen EXPERIENCE block, so it is set post-parse. interruptOnNewMessage
  // stays at its default (true): that default is what made the forwarded command destructive.
  return { ...parsed, inbound: { ...parsed.inbound, ...window } };
}

const drain = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TurnScript {
  /** Snapshots the turn reports, in order, before it (optionally) blocks. */
  usage?: AgentUsage[];
  /** Keep the turn running until release() — the "busy" in every test here. */
  hold?: boolean;
}

function rig(opts: {
  agent?: string;
  window?: { mergeWindowMs: number; maxMergeWindowMs: number };
} = {}) {
  const prompts: string[] = [];
  const sent: string[] = [];
  const answers: string[] = [];
  const script: TurnScript[] = [];
  let aborts = 0;
  let questionOnScreen = false;
  let release: () => void = () => {};
  let now = 1_000_000;

  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input, handlers) => {
            prompts.push(input.prompt);
            const turn = script.shift() ?? {};
            for (const u of turn.usage ?? []) handlers.onUsage?.(u);
            if (turn.hold) await new Promise<void>((r) => (release = r));
          },
          abort: () => {
            aborts += 1;
            release(); // a cancelled turn ends, as a real one does
          },
          dispose: () => {},
          modelSelector: () => undefined,
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const clock = {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const reg = new ConversationRegistry(
    config(opts.agent ?? 'cc', opts.window ?? { mergeWindowMs: 1, maxMergeWindowMs: 1 }),
    new Map([['discord', platform]]),
    factory,
    clock,
    {
      answerPendingAsk: (_id, text) => {
        if (!questionOnScreen) return false;
        answers.push(text);
        return true;
      },
    }
  );

  let n = 0;
  const post = (content: string): void =>
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
  const send = async (content: string): Promise<void> => {
    post(content);
    await drain();
  };
  return {
    send,
    post,
    prompts,
    answers,
    /** Queue what the next turn does. */
    nextTurn: (t: TurnScript) => void script.push(t),
    release: async () => {
      release();
      await drain();
    },
    advance: (ms: number) => void (now += ms),
    /** The running turn's agent puts a question on screen (the daemon holds it as a pending ask). */
    ask: () => void (questionOnScreen = true),
    aborts: () => aborts,
    /** Text the gateway sent that is not the header bubble. */
    replies: () => sent.filter((t) => !t.startsWith('🤖')),
  };
}

const COST = { amount: 30.6412, currency: 'USD' };

describe('/usage while a claude turn runs', () => {
  it('is answered by the gateway and leaves the running turn alone', async () => {
    const r = rig();
    r.nextTurn({ usage: [{ used: 412_000, size: 1_000_000 }], hold: true });
    await r.send('run the full suite');
    r.advance(252_000);

    await r.send('/usage');
    expect(r.aborts()).toBe(0); // the whole point: nothing was cancelled
    expect(r.prompts).toHaveLength(1); // …and /usage never reached the agent as a prompt
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('gateway snapshot of claude');
    expect(answer).toContain('412k / 1M (41%)');
    expect(answer).toContain('This turn: running 4m 12s');
    expect(answer).toContain('Send /usage again once the turn ends');

    await r.release();
    expect(r.prompts).toHaveLength(1); // nothing was queued behind the turn either
  });

  // claude-agent-acp attaches the cost only to the result-tied snapshot; the next turn's mid-stream
  // snapshots carry none, and must not wipe the last known total.
  it('quotes the cost the last finished turn reported, through later cost-less snapshots', async () => {
    const r = rig();
    r.nextTurn({ usage: [{ used: 100_000, size: 1_000_000, cost: COST }] });
    await r.send('first');
    r.nextTurn({ usage: [{ used: 150_000, size: 1_000_000 }], hold: true });
    await r.send('second');

    await r.send('/usage');
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('Cost: $30.64 this session, as of the last finished turn');
    expect(answer).toContain('150k / 1M (15%)'); // context is the live number, not the old one
    await r.release();
  });

  it('forgets the cost on /new, since the next session starts its own total', async () => {
    const r = rig();
    r.nextTurn({ usage: [{ used: 100_000, size: 1_000_000, cost: COST }] });
    await r.send('first');
    await r.send('/new');
    r.nextTurn({ hold: true });
    await r.send('fresh start');

    await r.send('/usage');
    expect(r.replies().at(-1)).toContain('Cost: not reported');
    await r.release();
  });

  it('is still forwarded to claude when the conversation is idle — its own answer knows more', async () => {
    const r = rig();
    await r.send('hello');
    await r.send('/usage');
    expect(r.prompts).toEqual(['hello', '/usage']);
    expect(r.replies().some((t) => t.includes('gateway snapshot'))).toBe(false);
  });

  // Inside the merge window nothing has reached the agent yet, but a forwarded /usage would be glued
  // onto the waiting message — `hello\n/usage` is one prompt, and no longer a command.
  it('is answered by the gateway while a message is still being collected, not merged into it', async () => {
    const r = rig({ window: { mergeWindowMs: 200, maxMergeWindowMs: 200 } });
    r.post('hello');
    await r.send('/usage');
    expect(r.replies().at(-1)).toContain('gateway snapshot of claude');
    expect(r.replies().at(-1)).not.toContain('This turn'); // collecting: not started, no elapsed time

    await drain(300);
    expect(r.prompts).toEqual(['hello']);
  });
});

describe('/context while a claude turn runs', () => {
  it('gets the gateway’s context answer, with the same note, instead of claude’s own', async () => {
    const r = rig();
    r.nextTurn({ usage: [{ used: 13_942, size: 200_000 }], hold: true });
    await r.send('working');

    await r.send('/context');
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toHaveLength(1);
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('14k / 200k (7%)');
    expect(answer).toContain('Send /context again once the turn ends');
    await r.release();
  });
});

describe('/usage while a codex turn runs', () => {
  it('is answered by the gateway rather than translated to /status and forwarded', async () => {
    const r = rig({ agent: 'cx' });
    r.nextTurn({ usage: [{ used: 50_000, size: 258_400 }], hold: true });
    await r.send('refactor it');

    await r.send('/usage');
    expect(r.aborts()).toBe(0);
    expect(r.prompts).toEqual(['refactor it']);
    const answer = r.replies().at(-1)!;
    expect(answer).toContain('gateway snapshot of codex');
    expect(answer).toContain('Cost: not reported'); // codex-acp sends no cost at all
    await r.release();
  });

  it('is still translated to /status when idle', async () => {
    const r = rig({ agent: 'cx' });
    await r.send('/usage');
    expect(r.prompts).toEqual(['/status']);
  });
});

describe('/usage on a harness that has none', () => {
  // A snapshot for a harness with no /usage would answer a question it could not have been asked;
  // the refusal is the honest reply whether or not a turn is running.
  it('keeps its refusal while busy', async () => {
    const r = rig({ agent: 'oc' });
    r.nextTurn({ hold: true });
    await r.send('working');
    await r.send('/usage');
    expect(r.replies().at(-1)).toContain('does not support /usage');
    await r.release();
  });
});

describe('a question on screen', () => {
  // The agent is blocked on a question; a registered command typed now is the user asking the
  // gateway something, not answering the agent. It used to be filed away as the answer.
  it('does not take a registered command as the answer, and still takes plain text', async () => {
    const r = rig();
    r.nextTurn({ usage: [{ used: 1000, size: 200_000 }], hold: true });
    await r.send('ask me something');
    r.ask();

    await r.send('/usage');
    expect(r.answers).toEqual([]);
    expect(r.replies().at(-1)).toContain('gateway snapshot of claude');
    expect(r.aborts()).toBe(0); // the question is still on screen, its turn still running

    await r.send('option B');
    expect(r.answers).toEqual(['option B']);
    await r.release();
  });

  it('still takes an answer that merely starts with a slash, like a path', async () => {
    const r = rig();
    r.nextTurn({ hold: true });
    await r.send('where should it go?');
    r.ask();
    await r.send('/srv/data');
    expect(r.answers).toEqual(['/srv/data']);
    await r.release();
  });
});
