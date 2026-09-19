import { describe, expect, it } from 'vitest';

import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * `/skills` interception.
 *
 * The command asks about state only the DAEMON holds (the lists agents report over ACP), so the
 * registry's whole job is to recognise it, resolve which agent it is about, and hand over. What
 * these pin is therefore the routing half: it fires the hook, it names the BOUND agent rather than
 * the default, and — the assertion that matters most — it never reaches the agent as a prompt.
 *
 * A forwarded `/skills` would not error. Every harness here treats an unknown slash name as text,
 * so the failure mode is a turn spent asking a coding agent about a command it has never heard of,
 * which is exactly the "ran a command, no output to display" dead end the daemon-command layer
 * exists to prevent.
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
// Shrink the merge window so a routed message dispatches promptly (see local-commands.test.ts).
const cfg: Config = {
  ...parsed,
  inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 },
};

const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function rig() {
  const sent: string[] = [];
  const prompts: string[] = [];
  const asked: Array<{ id: ConversationId; agentId: string }> = [];
  const sessions = new Map<string, AgentSession>();

  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input: { prompt: string }) => void prompts.push(input.prompt),
          abort: () => {},
          dispose: () => {},
        } as unknown as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const platform = {
    capabilities: { thread: false, editMessage: true, buttons: true, editButtons: true },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    sendButtons: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    editMessage: async () => {},
    editButtons: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const reg = new ConversationRegistry(cfg, new Map([['discord', platform]]), factory, clock, {
    onSkillsRequest: (id, agentId) => void asked.push({ id, agentId }),
  });

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
  return { send, prompts, asked, sent };
}

describe('/skills', () => {
  it('fires the hook and runs no turn', async () => {
    const { send, asked, prompts } = rig();
    await send('/skills');
    expect(asked).toHaveLength(1);
    expect(prompts).toEqual([]);
  });

  it('asks about the agent this conversation is bound to, not routing.default', async () => {
    // The binding is what a user means by "this agent". Reading routing.default instead would list
    // opencode's commands in a conversation claude is answering.
    const { send, asked } = rig();
    await send('/cc hello');
    await send('/skills');
    expect(asked.at(-1)?.agentId).toBe('cc');
  });

  it('falls back to the routed agent when nothing is bound yet', async () => {
    const { send, asked } = rig();
    await send('/skills');
    expect(asked[0]?.agentId).toBe('oc');
  });

  it('accepts the singular spelling, which is not registered', async () => {
    const { send, asked } = rig();
    await send('/skill');
    expect(asked).toHaveLength(1);
  });

  it('composes after an agent prefix', async () => {
    // Daemon commands are tested on the STRIPPED content, so `/cc /skills` must both rebind and be
    // recognised — the same property that makes `/cc /new` work.
    const { send, asked, prompts } = rig();
    await send('/cc /skills');
    expect(asked.at(-1)?.agentId).toBe('cc');
    expect(prompts).toEqual([]);
  });

  it('leaves a skill invocation alone', async () => {
    // The catalogue exists to be typed back. `/server-ops ...` is not in any gateway vocabulary, so
    // it must pass through untouched — this is the execution path the whole design leans on.
    const { send, prompts, asked } = rig();
    await send('/server-ops check the disk');
    expect(asked).toEqual([]);
    expect(prompts).toEqual(['/server-ops check the disk']);
  });
});
