import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentUsage, ModelSelector } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * `/context` and `/model` on a harness with no native spelling for them.
 *
 * Both existed in the generic vocabulary only to be REFUSED on opencode, because the translation
 * layer's single mechanism is text: it rewrites `/x` and hands it to the agent as a prompt, so a
 * capability the harness exposes over the protocol instead of as a slash command reads as "not
 * supported". Probed live against opencode 1.18.18, both are there — a `usage_update {used, size}`
 * on every turn, and a `model` select with its full model list — so the gateway answers them.
 *
 * The negatives matter as much as the answers: neither may reach the agent as a prompt.
 */

const parsed = parseConfig({
  platforms: { discord: { type: 'discord', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'oc', harness: 'opencode' },
  ],
  routing: {
    default: 'oc',
    pipeline: [
      { when: { command: 'oc' }, use: { agent: 'oc' } },
      { when: { command: 'cc' }, use: { agent: 'cc' } },
    ],
  },
});
// Shrink the merge window so a routed message dispatches promptly. Applied post-parse: `inbound`
// is part of the frozen EXPERIENCE block and would be discarded from the input.
const cfg: Config = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const SELECTOR: ModelSelector = {
  current: 'opencode/big-pickle',
  options: [
    { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
    { value: 'opencode/claude-sonnet-5', name: 'OpenCode Zen/Claude Sonnet 5' },
    { value: 'opencode/claude-opus-4-8', name: 'OpenCode Zen/Claude Opus 4.8' },
    { value: 'opencode/glm-5', name: 'OpenCode Zen/GLM-5' },
  ],
};

function rig(opts: { selector?: ModelSelector; usage?: AgentUsage } = {}) {
  const prompts: string[] = [];
  const sent: string[] = [];
  const setModelCalls: string[] = [];
  const sessions = new Map<string, AgentSession>();

  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input, handlers) => {
            prompts.push(input.prompt);
            if (opts.usage) handlers.onUsage?.(opts.usage);
          },
          abort: () => {},
          dispose: () => {},
          modelSelector: () => opts.selector,
          setModel: async (value: string) => {
            setModelCalls.push(value);
            return value;
          },
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
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

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock);
  let n = 0;
  const send = async (content: string): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };
  /** Text the gateway sent that is not the header bubble. */
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  return { send, prompts, replies, setModelCalls };
}

describe('/context answered by the gateway', () => {
  it('reports the numbers the agent last sent, without running a turn', async () => {
    const { send, prompts, replies } = rig({ usage: { used: 13942, size: 200_000 } });
    await send('hello'); // one real turn, which is what reports usage
    expect(prompts).toEqual(['hello']);

    await send('/context');
    expect(prompts).toEqual(['hello']); // no second turn: this is a question about the session
    expect(replies().at(-1)).toContain('14k / 200k (7%)');
  });

  it('says the numbers have not arrived yet rather than inventing a window', async () => {
    const { send, replies } = rig(); // agent never reports usage
    await send('/context');
    expect(replies().at(-1)).toContain('No context numbers yet');
  });
});

describe('/model answered by the gateway', () => {
  it('shows the live model and how to change it', async () => {
    const { send, prompts, replies } = rig({ selector: SELECTOR });
    await send('/model');
    expect(prompts).toEqual([]);
    expect(replies().at(-1)).toContain('opencode/big-pickle');
    expect(replies().at(-1)).toContain('4 available');
  });

  it('switches on a substring that picks exactly one model', async () => {
    const { send, replies, setModelCalls } = rig({ selector: SELECTOR });
    await send('/model glm');
    expect(setModelCalls).toEqual(['opencode/glm-5']);
    expect(replies().at(-1)).toContain('opencode/glm-5');
  });

  it('lists the candidates instead of guessing when a query is ambiguous', async () => {
    const { send, replies, setModelCalls } = rig({ selector: SELECTOR });
    await send('/model claude');
    expect(setModelCalls).toEqual([]); // picking one silently would change who answers
    const msg = replies().at(-1)!;
    expect(msg).toContain('matches 2 models');
    expect(msg).toContain('opencode/claude-sonnet-5');
    expect(msg).toContain('opencode/claude-opus-4-8');
  });

  it('takes an exact id even when it is a substring of another', async () => {
    const selector: ModelSelector = {
      current: 'a',
      options: [
        { value: 'opencode/glm-5', name: 'GLM-5' },
        { value: 'opencode/glm-5.1', name: 'GLM-5.1' },
      ],
    };
    const { send, setModelCalls } = rig({ selector });
    await send('/model opencode/glm-5');
    expect(setModelCalls).toEqual(['opencode/glm-5']);
  });

  it('says nothing matched rather than failing silently', async () => {
    const { send, replies, setModelCalls } = rig({ selector: SELECTOR });
    await send('/model gpt-9');
    expect(setModelCalls).toEqual([]);
    expect(replies().at(-1)).toContain('No model matches');
  });

  it('explains that the selector arrives with the first reply when there is no session yet', async () => {
    const { send, replies } = rig(); // no selector
    await send('/model');
    expect(replies().at(-1)).toContain('No model selector on this session yet');
  });
});
