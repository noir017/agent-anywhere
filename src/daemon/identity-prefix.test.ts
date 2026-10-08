import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationKind } from '../core/conversation.js';
import type { InboundMessage } from '../types.js';

/**
 * What the model actually receives as its prompt: specifically, that no sender name gets into it.
 *
 * A `[author]` prefix used to be added in every conversation whose kind was not `direct`. That
 * missed this deployment's actual shape. `access.allowFrom` admits one person, and their Telegram
 * private chat runs in topic mode, which reports `kind: 'thread'`. So every turn opened with their
 * own handle. These pin that no kind brings it back, and that the quote line carries no name
 * either.
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
  const send = async (
    content: string,
    authorName: string,
    quote?: { quotedContent: string; quotedAuthor: string }
  ): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind, user: 'u1' },
      messageId: `m${++n}`,
      content,
      authorName,
      ...quote,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };

  return { send, prompts };
}

describe('sender names in the prompt', () => {
  it.each<ConversationKind>(['direct', 'group', 'thread'])(
    'a %s message reaches the model as the bare text',
    async (kind) => {
      const { send, prompts } = rig(kind);
      await send('把这个文件发我', '张三');
      expect(prompts).toEqual(['把这个文件发我']);
    }
  );

  it('the quote line names nobody', async () => {
    const { send, prompts } = rig('thread');
    await send('这个再改一下', '张三', { quotedContent: '已经改好了，\n  见 diff', quotedAuthor: 'cc_bot' });
    expect(prompts).toEqual(['(replying to: "已经改好了， 见 diff")\n这个再改一下']);
  });

  it('a slash command stays bare, with no quote line either (the SDK reads the leading /)', async () => {
    const { send, prompts } = rig('group');
    await send('/compact', '张三', { quotedContent: 'earlier reply', quotedAuthor: 'cc_bot' });
    expect(prompts).toEqual(['/compact']);
  });
});
