import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRegistry } from './conversation.js';
import { ConversationStore } from './conversation-store.js';
import { resolveConversationCwd } from './agent-common.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';
import type { WorkdirOption } from '../core/workdir-menu.js';

/**
 * Choosing the directory a conversation works in.
 *
 * Two behaviours are being pinned here, and the second is the subtle one:
 *
 * 1. WHEN the question is asked. A conversation that has never run gets the directory menu from a
 *    bare agent command, because that is the moment the answer is free. One already under way gets
 *    the harness command list it always got — and "under way" is read off the STORE, so an
 *    idle-reclaimed conversation (child gone, session id kept) is NOT asked to re-pick. That case
 *    is the whole reason the predicate is not "is a child running".
 *
 * 2. What a move COSTS. A session is pinned to the directory it started in, so moving drops every
 *    agent's session id and the resident child. Re-picking the directory already in use must cost
 *    nothing at all — the menu marks it with ●, so tapping it is how a user dismisses the menu.
 *
 * The agent commands are exercised across all three harness shapes (`/cc` ACP + picker, `/oc` ACP +
 * picker, `/agy` no picker), because the directory is a property of the conversation and none of
 * this may depend on which runtime is bound.
 */

const root = mkdtempSync(join(tmpdir(), 'workdir-cmd-'));
for (const name of ['quantlab', 'agent-anywhere', 'uniagent']) mkdirSync(join(root, name));
const QUANTLAB = join(root, 'quantlab');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const parsed = parseConfig({
  platforms: { discord: { type: 'discord', token: 't' } },
  agents: [
    { id: 'cc', harness: 'claude', cwd: root },
    { id: 'oc', harness: 'opencode', cwd: root },
    { id: 'agy', harness: 'agy', cwd: root },
  ],
  routing: {
    default: 'cc',
    pipeline: [
      { when: { command: 'cc' }, use: { agent: 'cc' } },
      { when: { command: 'oc' }, use: { agent: 'oc' } },
      { when: { command: 'agy' }, use: { agent: 'agy' } },
    ],
  },
});
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

interface WorkdirMenuCall {
  id: ConversationId;
  agentId: string;
  options: WorkdirOption[];
  current: string;
}

function rig(opts: { buttons?: boolean } = {}) {
  const buttons = opts.buttons ?? true;
  const sent: string[] = [];
  const prompts: string[] = [];
  const disposed: string[] = [];
  const menus: WorkdirMenuCall[] = [];
  const pickers: string[] = [];
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
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => {
      disposed.push(id);
      sessions.delete(id);
    },
  };

  const platform = {
    capabilities: { thread: false, editMessage: true, buttons, editButtons: buttons },
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

  const file = join(mkdtempSync(join(tmpdir(), 'workdir-store-')), 'conversations.json');
  const store = new ConversationStore(file);
  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    {
      onPickerRequest: (_id, agentId) => void pickers.push(agentId),
      onWorkdirMenuRequest: (id, agentId, _msg, menu) =>
        void menus.push({ id, agentId, options: menu.options, current: menu.current }),
    },
    store
  );

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
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const key = 'discord#c1#'; // per_thread scope on a DM with no thread
  return { reg, send, replies, prompts, disposed, menus, pickers, store, key, factory };
}

describe('when the directory question is asked', () => {
  it('offers the menu on a bare agent command in a conversation that has never run', async () => {
    const { send, menus, pickers } = rig();
    await send('/cc');
    expect(menus).toHaveLength(1);
    expect(menus[0]!.agentId).toBe('cc');
    // The root leads, then the projects alphabetically.
    expect(menus[0]!.options.map((o) => o.name)).toEqual([
      menus[0]!.options[0]!.name,
      'agent-anywhere',
      'quantlab',
      'uniagent',
    ]);
    expect(menus[0]!.options[0]).toMatchObject({ path: root, root: true });
    expect(menus[0]!.current).toBe(root);
    // The command list is NOT also posted: one question at a time.
    expect(pickers).toEqual([]);
  });

  it('offers it for a harness with no command list of its own (agy) too', async () => {
    const { send, menus, replies } = rig();
    await send('/agy');
    expect(menus).toHaveLength(1);
    expect(menus[0]!.agentId).toBe('agy');
    // Not the plain binding ack it would otherwise have sent.
    expect(replies().join('')).not.toContain('is now answered by');
  });

  it('falls back to the command list once the agent has a session here', async () => {
    const { send, menus, pickers, store, key } = rig();
    await send('/cc hello'); // a turn, after which the runtime records its session id
    store.setAgentSession(key, 'cc', 'acp-session-1');

    await send('/cc');
    expect(menus).toHaveLength(0);
    expect(pickers).toEqual(['cc']);
  });

  // The case the store-based predicate exists for: an idle sweep stops the child but keeps the
  // session id, and the next message resumes it. Asking that user to re-pick a directory would
  // destroy the very context the reclaim was careful to preserve.
  it('still falls back to the command list after an idle reclaim killed the child', async () => {
    const { send, menus, pickers, store, key, factory } = rig();
    await send('/cc hello');
    store.setAgentSession(key, 'cc', 'acp-session-1');
    // What the sweeper does: the child goes, the conversation and its session id stay.
    factory.dispose(key);

    await send('/cc');
    expect(menus).toHaveLength(0);
    expect(pickers).toEqual(['cc']);
  });

  it('asks again after /new, which is the other moment the answer is free', async () => {
    const { send, menus, replies } = rig();
    await send('/cc hello');
    await send('/new');
    expect(replies().at(-1)).toContain('Context cleared');
    expect(menus).toHaveLength(1);
  });

  it('never interrupts a command that carries a prompt', async () => {
    const { send, menus, prompts } = rig();
    await send('/cc look at this');
    expect(prompts).toEqual(['look at this']);
    expect(menus).toHaveLength(0);
  });

  it('answers with text where buttons cannot be posted', async () => {
    const { send, menus, replies } = rig({ buttons: false });
    await send('/cd');
    expect(menus).toHaveLength(0);
    expect(replies().at(-1)).toContain('Working dir:');
    expect(replies().at(-1)).toContain('/cd quantlab');
  });
});

describe('moving a conversation', () => {
  it('records the directory, drops every session id, and stops the child', async () => {
    const { send, replies, disposed, store, key } = rig();
    await send('/cc hello');
    store.setAgentSession(key, 'cc', 'acp-1');
    store.setAgentSession(key, 'oc', 'oc-1');
    disposed.length = 0;

    await send('/cd quantlab');
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
    // Every agent's, not just the bound one's: the directory belongs to the conversation.
    expect(store.agentSession(key, 'cc')).toBeUndefined();
    expect(store.agentSession(key, 'oc')).toBeUndefined();
    expect(disposed).toEqual([key]);
    expect(replies().at(-1)).toContain('fresh session');
  });

  it('is what the runtimes will read at spawn', async () => {
    const { reg, send, key } = rig();
    await send('/cd quantlab');
    // workdirOf is the same call agent-acp/agent-agy make (resolveConversationCwd), so this is the
    // directory the next child actually starts in — and what the footer reports.
    expect(reg.workdirOf(key, 'cc')).toBe(QUANTLAB);
    // …for every agent that answers here, not only the one bound when the move was made.
    expect(reg.workdirOf(key, 'oc')).toBe(QUANTLAB);
  });

  it('costs nothing when the directory picked is the one already in use', async () => {
    const { send, replies, disposed, store, key } = rig();
    await send('/cd quantlab');
    store.setAgentSession(key, 'cc', 'acp-2');
    disposed.length = 0;

    await send('/cd quantlab');
    expect(replies().at(-1)).toContain('nothing reset');
    expect(disposed).toEqual([]);
    expect(store.agentSession(key, 'cc')).toBe('acp-2');
  });

  it('clears the override when the root is chosen, so config can still move it later', async () => {
    const { send, store, key } = rig();
    await send('/cd quantlab');
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
    await send(`/cd ${root}`);
    expect(store.conversationCwd(key)).toBeUndefined();
  });

  it('refuses to guess between two matches, and changes nothing', async () => {
    const { send, replies, store, key } = rig();
    await send('/cd a'); // matches agent-anywhere and quantlab (both contain "a")
    expect(replies().at(-1)).toContain('matches');
    expect(store.conversationCwd(key)).toBeUndefined();
  });

  it('says so when nothing matches', async () => {
    const { send, replies, store, key } = rig();
    await send('/cd nowhere-at-all');
    expect(replies().at(-1)).toContain('No directory matches');
    expect(store.conversationCwd(key)).toBeUndefined();
  });

  it('survives /new: a reset clears the context, not the place it happens in', async () => {
    const { send, store, key } = rig();
    await send('/cd quantlab');
    await send('/new');
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
  });

  it('never reaches the agent as a prompt', async () => {
    const { send, prompts } = rig();
    await send('/cd');
    await send('/cd quantlab');
    expect(prompts).toEqual([]);
  });
});

describe('applying a click', () => {  it('moves the conversation the menu was opened for', async () => {
    const { reg, send, store, key } = rig();
    await send('/cc');
    expect(reg.applyWorkdirChoice(key, 'cc', QUANTLAB)).toEqual({
      kind: 'applied',
      path: QUANTLAB,
    });
    expect(store.conversationCwd(key)).toBe(QUANTLAB);
  });

  it('refuses when another agent has taken over since the menu was posted', async () => {
    const { reg, send, key } = rig();
    await send('/cc');
    await send('/oc'); // rebind
    const result = reg.applyWorkdirChoice(key, 'cc', QUANTLAB);
    expect(result.kind).toBe('rebound');
  });

  it('reports a directory that disappeared between the menu and the tap', async () => {
    const { reg, send, key } = rig();
    await send('/cc');
    const result = reg.applyWorkdirChoice(key, 'cc', join(root, 'deleted-since'));
    expect(result).toEqual({ kind: 'missing', path: join(root, 'deleted-since') });
  });
});

/**
 * The other end of the wire: what agent-acp and agent-agy call at spawn to decide where to put the
 * child. Tested directly because the runtimes themselves can only be exercised by launching a
 * harness — and this one function is the whole of what `/cd` changes about them.
 */
describe('resolveConversationCwd (read by both runtimes at spawn)', () => {
  const def = cfg.agents.find((a) => a.id === 'cc')!;
  const file = () => join(mkdtempSync(join(tmpdir(), 'workdir-resolve-')), 'conversations.json');

  it('falls back to the agent root when the conversation has chosen nothing', () => {
    expect(resolveConversationCwd(def, 'k', new ConversationStore(file()))).toBe(root);
    // …and with no store at all (a deployment or test that runs without one).
    expect(resolveConversationCwd(def, 'k')).toBe(root);
  });

  it('honours the recorded directory', () => {
    const store = new ConversationStore(file());
    store.setConversationCwd('k', 'cc', QUANTLAB);
    expect(resolveConversationCwd(def, 'k', store)).toBe(QUANTLAB);
  });

  // A spawn that died on a missing cwd would strand the conversation with an error nobody can act
  // on from a phone; the agent's own workspace is still a place it can answer from.
  it('falls back to the root when the recorded directory has since been deleted', () => {
    const store = new ConversationStore(file());
    store.setConversationCwd('k', 'cc', join(root, 'deleted-since'));
    expect(resolveConversationCwd(def, 'k', store)).toBe(root);
  });
});
