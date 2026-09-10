import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationKind } from '../core/conversation.js';
import type { InboundMessage } from '../types.js';

/**
 * What the model actually receives as its prompt — specifically, the `[author]` identity prefix.
 *
 * The prefix exists so an agent in a busy group can tell two speakers apart. In a DM it names the
 * only human present, every single turn, which buys nothing and opens each turn with chat-
 * transcript formatting instead of the question. These pin both halves so neither can be
 * "simplified" back into the other.
 *
 * Driven through the real ConversationRegistry rather than by calling mergePrompt (which is
 * private): the prompt is assembled several layers down from routing, and a direct unit test
 * would pin the helper while letting the wiring drift.
 */

const makeConfig = (): Config => {
  const cfg = parseConfig({
    // requireMention off: a group message with no @mention is otherwise dropped by the inbound
    // gate before any prompt is assembled, so the group cases would pass vacuously.
    platforms: { discord: { type: 'discord', token: 't', chat: { requireMention: false } } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc', pipeline: [] },
  });
  // Shrink the merge window so a routed message dispatches promptly (see command-routing.test.ts).
  return { ...cfg, inbound: { ...cfg.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
};

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function rig(kind: ConversationKind) {
  const prompts: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => void prompts.push(input.prompt),
          abort: () => {},
          dispose: () => {},
        };
        sessions.set(conversationId, s);
      }
      return s!;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }) => ({ address, messageId: 'm1' }),
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const reg = new ConversationRegistry(makeConfig(), new Map([['discord', platform]]), factory, clock, {}, {
    boundAgent: () => undefined,
    bind: () => {},
    agentSession: () => undefined,
    setAgentSession: () => {},
    clear: () => {},
    conversationCwd: () => undefined,
    setConversationCwd: () => {},
    clearAgentSessions: () => {},
    conversationTitle: () => undefined,
    titlePinned: () => false,
    setConversationTitle: () => {},
  } as never);

  let n = 0;
  const send = async (content: string, authorName: string, user = 'u1'): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind, user },
      messageId: `m${++n}`,
      content,
      authorName,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };

  return { send, prompts };
}

describe('identity prefix in the prompt', () => {
  it('a DM reaches the model as the bare message', async () => {
    const { send, prompts } = rig('direct');
    await send('把这个文件发我', '张三');
    expect(prompts).toEqual(['把这个文件发我']);
  });

  it('a group keeps the names, which is the only place they distinguish anyone', async () => {
    const { send, prompts } = rig('group');
    await send('把这个文件发我', '张三');
    expect(prompts).toEqual(['[张三] 把这个文件发我']);
  });

  it('a thread keeps them too (several people can post in one)', async () => {
    const { send, prompts } = rig('thread');
    await send('把这个文件发我', '张三');
    expect(prompts).toEqual(['[张三] 把这个文件发我']);
  });

  it('a slash command stays bare in a group as well (the SDK reads the leading /)', async () => {
    const { send, prompts } = rig('group');
    await send('/compact', '张三');
    expect(prompts).toEqual(['/compact']);
  });
});
