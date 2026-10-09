import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Daemon } from './daemon.js';
import { TurnRunner } from './turn-runner.js';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory } from './agent.js';
import type { AgentElicitation, ButtonInteraction, ElicitAnswer, InboundMessage } from '../types.js';

/**
 * The agent asks the user a question over ACP elicitation, end to end on the daemon side: the turn
 * hands the question to the daemon with its own lane, and the daemon puts it to the user as buttons
 * through the same machinery as the `ask` reverse command.
 */

interface SentButtons {
  channelId: string;
  text: string;
  buttons: { id: string; label: string }[];
}

function stubAdapter(buttons: boolean): PlatformAdapter & { asked: SentButtons[]; edits: string[] } {
  const asked: SentButtons[] = [];
  const edits: string[] = [];
  return {
    platform: 'p',
    platformType: 'discord',
    capabilities: { editMessage: true, reaction: false, typing: false, maxMessageLength: 2000,
      reply: false, thread: false, buttons, slashCommands: false },
    asked,
    edits,
    async sendMessage(channelId) { return { channelId, messageId: 'm' }; },
    async editMessage(_ref, text) { edits.push(text); },
    measureRendered: (t) => t.length,
    async deleteMessage() {},
    async sendFile(channelId) { return { channelId, messageId: 'f' }; },
    async addReaction() {},
    async removeReaction() {},
    async replyMessage(ref) { return ref; },
    async createThread() { return { threadId: 't' }; },
    async sendButtons(channelId, text, btns) {
      asked.push({ channelId, text, buttons: btns });
      return { channelId, messageId: `b${asked.length}` };
    },
    async registerCommands() {},
    async startTyping() {},
    async stopTyping() {},
    async fetchHistory() { return []; },
    onMessage() {},
    onButton() {},
    onCommand() {},
    async start() {},
    async stop() {},
  };
}

const cfg = parseConfig({
  platforms: { p: { type: 'discord', token: 't' } },
  agents: [{ id: 'a', harness: 'opencode' }],
  routing: { default: 'a' },
});

const noAgents: AgentFactory = { getOrCreate: () => { throw new Error('unused'); }, dispose: () => {} };

/** The two private entry points under test: the hook a turn calls, and a button click. */
interface DaemonInternals {
  onElicitRequest(sid: string, platform: PlatformAdapter, channelId: string, req: AgentElicitation): Promise<ElicitAnswer>;
  onButton(ev: ButtonInteraction): void;
}

function click(d: DaemonInternals, sent: SentButtons, index: number): void {
  d.onButton({ platform: 'p', channelId: sent.channelId, userId: 'u', messageId: 'b', buttonId: sent.buttons[index]!.id });
}

const twoQuestions: AgentElicitation = {
  message: 'Please answer the following questions.',
  questions: [
    { key: 'question_0', prompt: 'Which database?', multi: false, options: [
      { label: 'Postgres', value: 'pg', description: 'already running here' },
      { label: 'MySQL', value: 'mysql' },
    ] },
    { key: 'question_1', prompt: 'Which regions?', multi: true, options: [
      { label: 'EU', value: 'eu' },
      { label: 'US', value: 'us' },
    ] },
  ],
};

describe('Daemon.onElicitRequest (agent question → buttons)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks each question in order and answers with the option values, not the labels', async () => {
    const adapter = stubAdapter(true);
    const d = new Daemon(cfg, new Map([['p', adapter]]), noAgents, '/tmp/unused.sock') as unknown as DaemonInternals;

    const answer = d.onElicitRequest('s', adapter, 'thread-7', twoQuestions);
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.asked).toHaveLength(1); // one round at a time
    expect(adapter.asked[0]!.channelId).toBe('thread-7'); // the turn's own lane
    expect(adapter.asked[0]!.text).toBe('(1/2) Which database?\n\n**Postgres** — already running here');
    click(d, adapter.asked[0]!, 0);

    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.asked).toHaveLength(2);
    expect(adapter.asked[1]!.text).toBe('(2/2) Which regions?');
    click(d, adapter.asked[1]!, 1);

    // Multi-select comes back wrapped in an array; single-select as the bare value.
    await expect(answer).resolves.toEqual({ action: 'accept', content: { question_0: 'pg', question_1: ['us'] } });
    expect(adapter.edits).toEqual([
      '(1/2) Which database?\n\n**Postgres** — already running here\n\n→ Selected: Postgres',
      '(2/2) Which regions?\n\n→ Selected: US',
    ]);
  });

  it('an unanswered round cancels the whole form and asks nothing further', async () => {
    const adapter = stubAdapter(true);
    const d = new Daemon(cfg, new Map([['p', adapter]]), noAgents, '/tmp/unused.sock') as unknown as DaemonInternals;

    const answer = d.onElicitRequest('s', adapter, 'c', twoQuestions);
    await vi.advanceTimersByTimeAsync(0);
    // Still waiting well past the CLI `ask` default: an elicitation has no --timeout of its own.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(adapter.edits).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);

    await expect(answer).resolves.toEqual({ action: 'cancel' });
    expect(adapter.asked).toHaveLength(1);
    expect(adapter.edits).toEqual(['(1/2) Which database?\n\n**Postgres** — already running here\n\n(timed out)']);
  });

  it('a platform without buttons cancels instead of posting a question nobody can answer', async () => {
    const adapter = stubAdapter(false);
    const d = new Daemon(cfg, new Map([['p', adapter]]), noAgents, '/tmp/unused.sock') as unknown as DaemonInternals;
    await expect(d.onElicitRequest('s', adapter, 'c', twoQuestions)).resolves.toEqual({ action: 'cancel' });
    expect(adapter.asked).toEqual([]);
  });
});

describe('TurnRunner → onElicitRequest hook', () => {
  const question: AgentElicitation = {
    message: 'Pick one',
    questions: [{ key: 'question_0', prompt: 'Pick one', multi: false, options: [{ label: 'A', value: 'a' }] }],
  };

  /** An agent that asks one question mid-turn and records the answer it got back. */
  function askingAgents(got: ElicitAnswer[]): AgentFactory {
    return {
      getOrCreate: (sessionId) => ({
        sessionId,
        runTurn: async (_turn, handlers) => {
          got.push(await handlers.onElicit!(question));
        },
        abort: () => {},
        dispose: () => {},
      }),
      dispose: () => {},
    };
  }

  const deps = {
    tokenFor: () => 'tok',
    agentIdOf: () => 'a',
    getModelOverride: () => undefined,
    setActiveChannel: () => {},
    deleteActiveChannel: () => {},
  };
  const clock = { now: () => 0, schedule: () => () => {} };
  const msg: InboundMessage = { platform: 'p', channelId: 'c1', userId: 'u', messageId: 'm', content: 'hi', timestamp: 0 };

  it("hands the question to the daemon with the turn's own platform and channel", async () => {
    const adapter = stubAdapter(true);
    const got: ElicitAnswer[] = [];
    const seen: string[] = [];
    const runner = new TurnRunner(cfg, new Map([['p', adapter]]), askingAgents(got), clock, deps, {
      onElicitRequest: async (sid, platform, channelId, req) => {
        seen.push(`${sid} ${platform.platform} ${channelId} ${req.message}`);
        return { action: 'accept', content: { question_0: 'a' } };
      },
    });
    await runner.runTurn('s1', [msg]);
    expect(seen).toEqual(['s1 p c1 Pick one']);
    expect(got).toEqual([{ action: 'accept', content: { question_0: 'a' } }]);
  });

  it('with no hook wired, or a hook that throws, the agent is told the question was cancelled', async () => {
    const adapter = stubAdapter(true);
    const got: ElicitAnswer[] = [];
    await new TurnRunner(cfg, new Map([['p', adapter]]), askingAgents(got), clock, deps).runTurn('s1', [msg]);
    await new TurnRunner(cfg, new Map([['p', adapter]]), askingAgents(got), clock, deps, {
      onElicitRequest: async () => { throw new Error('renderer exploded'); },
    }).runTurn('s1', [msg]);
    expect(got).toEqual([{ action: 'cancel' }, { action: 'cancel' }]);
  });
});
