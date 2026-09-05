import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ButtonInteraction, InboundMessage, MessageRef } from '../types.js';

/**
 * The `/cd` menu end to end: posting it, turning its pages, and clicking one of its directories.
 *
 * Exists for the reason `model-menu-click.test.ts` does — a menu is a snapshot and a click is a
 * later event, so on a button a silent `return` is indistinguishable from a dead one and every
 * path has to end in words. What it adds on top of the model menu's version is that a click here
 * is DESTRUCTIVE: it ends the session the conversation was using. So the two cases worth the most
 * are the ones where it must not be — a re-pick of the current directory, and a menu that has been
 * outlived by a rebind.
 */

const CONVERSATION = { platform: 'tg', channel: 'c1', kind: 'direct' as const, user: 'u1' };
/** What Telegram actually reports on a click: the callback_query id, not a message id. */
const CALLBACK_QUERY_ID = '4242424242424242';
const MENU_MSG = 'menu-msg-id';

const root = mkdtempSync(join(tmpdir(), 'workdir-click-'));
// Enough projects to force a second page (PAGE_SIZE is 6, and the root takes a slot).
const PROJECTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
for (const name of PROJECTS) mkdirSync(join(root, name));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(access?: string[]): Config {
  const parsed = parseConfig({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude', cwd: root },
      { id: 'oc', harness: 'opencode', cwd: root },
    ],
    routing: {
      default: 'cc',
      pipeline: [
        { when: { command: 'cc' }, use: { agent: 'cc' } },
        { when: { command: 'oc' }, use: { agent: 'oc' } },
      ],
    },
    ...(access ? { access: { allowFrom: access } } : {}),
  });
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function rig(opts: { access?: string[]; caps?: { buttons?: boolean; editButtons?: boolean } } = {}) {
  const sent: string[] = [];
  const buttonSends: Array<{ text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const buttonEdits: Array<{ messageId: string; text: string; buttons: Array<{ id: string; label: string }> }> = [];
  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async () => {},
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
    platform: 'tg',
    platformType: 'telegram',
    capabilities: {
      thread: true, editMessage: true, reaction: true, reply: true,
      slashCommands: true, typing: true, maxMessageLength: 4096,
      buttons: opts.caps?.buttons ?? true,
      editButtons: opts.caps?.editButtons ?? true,
    },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    sendButtons: async (
      address: { channel: string },
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonSends.push({ text, buttons });
      return { address, messageId: MENU_MSG };
    },
    editButtons: async (
      ref: MessageRef,
      text: string,
      buttons: Array<{ id: string; label: string }>
    ) => {
      buttonEdits.push({ messageId: ref.messageId, text, buttons });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const file = join(mkdtempSync(join(tmpdir(), 'workdir-click-store-')), 'conversations.json');
  const store = new ConversationStore(file);
  const daemon = new Daemon(
    config(opts.access),
    new Map([['tg', platform]]),
    agents,
    '/tmp/aa-workdir-menu-test.sock',
    store
  );
  const d = daemon as unknown as {
    onInbound(m: InboundMessage): void;
    onButton(ev: ButtonInteraction): void;
  };

  let n = 0;
  const send = async (content: string, user = 'u1'): Promise<void> => {
    d.onInbound({
      conversation: { ...CONVERSATION, user },
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    await drain();
  };
  const click = async (buttonId: string, user = 'u1'): Promise<void> => {
    d.onButton({ conversation: { ...CONVERSATION, user }, messageId: CALLBACK_QUERY_ID, buttonId });
    await drain();
  };
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  const menu = () => buttonSends.at(-1)!;
  const pickIds = () => menu().buttons.filter((b) => b.id.startsWith('wdr:')).map((b) => b.id);
  const navIds = () => menu().buttons.filter((b) => b.id.startsWith('wdp:')).map((b) => b.id);
  const key = 'tg#c1#';

  return { send, click, replies, menu, pickIds, navIds, buttonSends, buttonEdits, disposed, store, key };
}

describe('opening the menu', () => {
  it('posts the directories as buttons on a bare agent command in a fresh conversation', async () => {
    const r = rig();
    await r.send('/cc');
    expect(r.buttonSends).toHaveLength(1);
    expect(r.menu().text).toContain('page 1/2');
    expect(r.menu().text).toContain('starts a fresh session');
    expect(r.pickIds()).toHaveLength(6);
    expect(r.navIds()).toHaveLength(2);
  });

  it('opens on the page holding the current directory', async () => {
    const r = rig();
    await r.send(`/cd ${join(root, 'zeta')}`); // the 6th project — second page, after the root
    await r.send('/cd');
    expect(r.menu().text).toContain('page 2/2');
    expect(r.menu().buttons.some((b) => b.label.startsWith('●'))).toBe(true);
  });

  it('answers as text where buttons cannot be edited (LINE, QQ)', async () => {
    // A menu that can never be paged OR retired would leave live-looking buttons above its own ack.
    const r = rig({ caps: { buttons: true, editButtons: false } });
    await r.send('/cd');
    expect(r.buttonSends).toHaveLength(0);
    expect(r.replies().at(-1)).toContain('Working dir:');
  });

  it('retires the previous menu instead of leaving two live in one conversation', async () => {
    const r = rig();
    await r.send('/cd');
    await r.send('/cd');
    expect(r.buttonEdits.at(-1)!.text).toContain('superseded');
    expect(r.buttonEdits.at(-1)!.buttons).toEqual([]); // an empty array is how a menu is retired
  });
});

describe('turning the page', () => {
  it('edits the same message and keeps indices absolute', async () => {
    const r = rig();
    await r.send('/cd');
    const [prev] = r.navIds();
    await r.click(prev!);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.messageId).toBe(MENU_MSG);
    expect(edit.text).toContain('page 2/2');
    // Second page starts at index 6, not back at 0 — a page turn may never re-point a button.
    expect(edit.buttons[0]!.id.endsWith(':6')).toBe(true);
  });
});

describe('clicking a directory', () => {
  it('moves the conversation and retires the menu', async () => {
    const r = rig();
    await r.send('/cc');
    const target = r.pickIds()[1]!; // the first project after the root
    await r.click(target);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.text).toContain('Working in');
    expect(edit.buttons).toEqual([]);
    expect(r.store.conversationCwd(r.key)).toBe(join(root, 'alpha'));
    expect(r.disposed).toContain(r.key);
  });

  it('costs nothing when the tap lands on the directory already in use', async () => {
    const r = rig();
    await r.send('/cc');
    r.disposed.length = 0;
    await r.click(r.pickIds()[0]!); // the root, which is where the conversation already is
    expect(r.buttonEdits.at(-1)!.text).toContain('nothing reset');
    expect(r.disposed).toEqual([]);
  });

  it('refuses a menu another agent has taken over, rather than applying it anyway', async () => {
    const r = rig();
    await r.send('/cc');
    const target = r.pickIds()[1]!;
    // Rebind WITH a prompt: a bare `/oc` would open its own menu and retire this one, which is a
    // different (and already-covered) path. Here the stale menu is still live when it is clicked.
    await r.send('/oc have a look');
    await r.click(target);
    const edit = r.buttonEdits.at(-1)!;
    expect(edit.text).toContain('no longer applies');
    expect(r.store.conversationCwd(r.key)).toBeUndefined();
  });

  it('answers a click on a menu the daemon no longer knows about', async () => {
    const r = rig();
    await r.send('/cc');
    const target = r.pickIds()[1]!;
    await r.click(target); // uses the menu up
    await r.click(target); // …and again
    expect(r.replies().at(-1)).toContain('expired');
  });

  it('ignores a click from outside the allowlist', async () => {
    const r = rig({ access: ['tg:u1'] });
    await r.send('/cc');
    const target = r.pickIds()[1]!;
    const editsBefore = r.buttonEdits.length;
    await r.click(target, 'intruder');
    expect(r.buttonEdits).toHaveLength(editsBefore);
    expect(r.store.conversationCwd(r.key)).toBeUndefined();
  });
});
