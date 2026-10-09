import { describe, expect, it } from 'vitest';
import { TurnRunner } from './turn-runner.js';
import { parseConfig, type Config } from '../config/schema.js';
import { OutboundPacer } from '../core/outbound-pacer.js';
import { withOutboundPacing } from './paced-adapter.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory } from './agent.js';
import type { InboundMessage, MessageRef } from '../types.js';

/**
 * The turn, wired the way the daemon wires it: every write through the paced adapter, tool bubbles
 * in the 'progress' lane. What is pinned is the failure this replaced — a tool bubble whose writes
 * kept failing used to fail inside the turn's side-effect chain, freezing the bubble and queueing
 * the reply behind it. Now the reply goes out regardless, the turn ends on time, and nothing keeps
 * retrying a finished turn's bubble afterwards.
 */

function recordingAdapter(): PlatformAdapter & { sent: string[]; editAttempts: number } {
  const sent: string[] = [];
  const adapter = {
    platform: 'p',
    platformType: 'telegram',
    capabilities: { editMessage: true, reaction: false, typing: false, maxMessageLength: 4096,
      reply: false, thread: false, buttons: false, slashCommands: false },
    sent,
    editAttempts: 0,
    async sendMessage(channelId: string, text: string): Promise<MessageRef> {
      sent.push(text);
      return { channelId, messageId: `m${sent.length}` };
    },
    async editMessage(): Promise<void> {
      adapter.editAttempts++;
      throw new Error('socket hang up'); // every edit fails; nothing states a wait
    },
    measureRendered: (t: string) => t.length,
    async deleteMessage() {},
    async sendFile(channelId: string) { return { channelId, messageId: 'f' }; },
    async addReaction() {},
    async removeReaction() {},
    async replyMessage(ref: MessageRef) { return ref; },
    async createThread() { return { threadId: 't' }; },
    async sendButtons(channelId: string) { return { channelId, messageId: 'b' }; },
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
  return adapter;
}

const agents: AgentFactory = {
  getOrCreate: (sessionId) => ({
    sessionId,
    runTurn: async (_turn, h) => {
      h.onToolStart({ name: 'Read', inputPreview: 'a.ts', index: 0 });
      h.onToolFinish({ name: 'Read', ok: true, durationMs: 5, index: 0 }); // this edit fails
      h.onSegmentBreak();
      h.onText('done');
    },
    abort: () => {},
    dispose: () => {},
  }),
  dispose: () => {},
};

function config(): Config {
  const base = parseConfig({
    platforms: { p: { type: 'telegram', token: 't' } },
    agents: [{ id: 'a', harness: 'opencode' }],
    routing: { default: 'a' },
  });
  return {
    ...base,
    outbound: { ...base.outbound, finalizeWaitMs: 100 },
    tools: { ...base.tools, retryIntervalMs: 20, maxRetryMs: 20 },
  };
}

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

const deps = {
  tokenFor: () => 'tok',
  agentIdOf: () => 'a',
  getModelOverride: () => undefined,
  setActiveChannel: () => {},
  deleteActiveChannel: () => {},
};

const msg: InboundMessage = { platform: 'p', channelId: 'c1', userId: 'u', messageId: 'm', content: 'hi', timestamp: 0 };

describe('a turn on a chat whose tool-bubble writes keep failing', () => {
  it('still delivers the reply, ends on time, and stops retrying once it is over', async () => {
    const cfg = config();
    const adapter = recordingAdapter();
    const paced = withOutboundPacing(adapter, new OutboundPacer(cfg.outbound, clock));
    const runner = new TurnRunner(cfg, new Map([['p', paced]]), agents, clock, deps);

    const began = Date.now();
    await runner.runTurn('s', [msg]);

    // The bubble opened, its ✓ never landed — and the answer went out anyway.
    expect(adapter.sent).toEqual(['📖 Read: "a.ts"', 'done']);
    expect(adapter.editAttempts).toBeGreaterThan(1); // it was retried while the turn lasted
    // Bounded by finalizeWaitMs, not by how long the bubble keeps failing.
    expect(Date.now() - began).toBeLessThan(1_000);

    const attemptsAtEnd = adapter.editAttempts;
    await new Promise((r) => setTimeout(r, 150));
    expect(adapter.editAttempts).toBe(attemptsAtEnd); // a finished turn's bubble is left alone
  });
});
