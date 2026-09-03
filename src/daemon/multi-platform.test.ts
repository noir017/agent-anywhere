import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { TurnRunner } from './turn-runner.js';
import { parseConfig } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * Multi-platform runtime: one daemon, several adapters keyed by instance id.
 * Verifies the two load-bearing behaviors:
 *  - inbound gating is PER INSTANCE (each instance's chat block applies to its own messages)
 *  - outbound of a turn goes to the adapter of the batch's platform instance
 */

/** Stub adapter recording sendMessage/addReaction calls. */
function stubAdapter(id: string): PlatformAdapter & { sent: string[]; reacted: string[] } {
  const sent: string[] = [];
  const reacted: string[] = [];
  return {
    platform: id,
    platformType: 'discord',
    capabilities: { editMessage: true, reaction: true, typing: false, maxMessageLength: 2000,
      reply: false, thread: false, buttons: false, slashCommands: false },
    sent,
    reacted,
    async sendMessage(address, text) { sent.push(text); return { address, messageId: `m${sent.length}` }; },
    async editMessage() {},
    measureRendered: (t) => t.length,
    async deleteMessage() {},
    async sendFile(address) { return { address, messageId: 'f' }; },
    async addReaction(_ref, emoji) { reacted.push(emoji); },
    async removeReaction() {},
    async replyMessage(ref, text) { sent.push(text); return ref; },
    async createThread() { return { address: { channel: 't' } }; },
    async sendButtons(address) { return { address, messageId: 'b' }; },
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

const clock = { now: () => 0, schedule: () => () => {} };

const stubAgents: AgentFactory = {
  getOrCreate: (conversationId) => ({
    conversationId,
    runTurn: async (_turn, handlers) => { handlers.onText('hello'); },
    abort: () => {},
    dispose: () => {},
  }),
  dispose: () => {},
};

const cfg = parseConfig({
  platforms: {
    strict: { type: 'discord', token: 't1' }, // default chat: requireMention=true
    open: { type: 'discord', token: 't2', chat: { requireMention: false } },
  },
  agents: [{ id: 'a', harness: 'claude' }],
  routing: { default: 'a' },
});

function msg(platform: string, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    conversation: { platform, channel: 'c1', kind: 'group', user: 'u1' },
    messageId: `id-${Math.random()}`,
    content: 'hi',
    timestamp: 0,
    ...over,
  };
}

describe('multi-platform runtime', () => {
  it('gating applies per instance: strict drops unmentioned guild messages, open accepts them', () => {
    const strict = stubAdapter('strict');
    const open = stubAdapter('open');
    const reg = new ConversationRegistry(cfg, new Map([['strict', strict], ['open', open]]), stubAgents, clock);
    reg.route(msg('strict')); // no mention → gated out; no merger, no reaction
    reg.route(msg('open')); // requireMention=false → ingested; 👀 reaction goes to open's adapter
    expect(strict.reacted).toEqual([]);
    expect(open.reacted).toEqual(['👀']);
    reg.dispose();
  });

  it("a turn's outbound goes to the adapter of the batch's platform instance", async () => {
    const strict = stubAdapter('strict');
    const open = stubAdapter('open');
    const runner = new TurnRunner(cfg, new Map([['strict', strict], ['open', open]]), stubAgents, clock, {
      tokenFor: () => 'tok',
      agentIdOf: () => 'a',
      getModelOverride: () => undefined,
      setActiveAddress: (_id, _address, platformId) => { expect(platformId).toBe('open'); },
      deleteActiveAddress: () => {},
    });
    await runner.runTurn('open#c1', [msg('open')]);
    expect(open.sent).toContain('hello');
    expect(strict.sent).toEqual([]);
  });

  it('an unknown platform instance fails the turn with a clear error', async () => {
    const open = stubAdapter('open');
    const runner = new TurnRunner(cfg, new Map([['open', open]]), stubAgents, clock, {
      tokenFor: () => 'tok',
      agentIdOf: () => 'a',
      getModelOverride: () => undefined,
      setActiveAddress: () => {},
      deleteActiveAddress: () => {},
    });
    await expect(runner.runTurn('x', [msg('ghost')])).rejects.toThrowError(/no platform adapter for instance "ghost"/);
  });
});
