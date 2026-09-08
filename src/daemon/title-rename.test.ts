import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter, PlatformCapabilities } from '../platform/adapter.js';
import type { AgentFactory, AgentSession, AgentStreamHandlers } from './agent.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { InboundMessage } from '../types.js';

/**
 * A conversation's chat lane taking the name the agent gave it.
 *
 * The bug: a Telegram forum topic keeps whatever name it was created with for as long as it
 * exists. Meanwhile the harness generates an accurate title and reports it over ACP
 * (`session_info_update`), which the gateway dropped — so a topic-per-task workflow ended up as a
 * column of names typed before any of the work happened.
 *
 * These run the real `Daemon` and the real `ConversationStore` on a temp file; only the platform
 * adapter and the agent are fakes. That matters because the interesting behaviour is not the API
 * call — it is everything around it: the dedupe against what was last set, the persistence that
 * stops a restart re-renaming everything, the capability and setting gates, and the rule that none
 * of it may ever break a turn.
 */

const CONVERSATION = {
  platform: 'tg',
  channel: '-1001234567890',
  thread: '99',
  kind: 'thread' as const,
  user: 'u1',
};

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function config(opts: { autoRenameThread?: boolean } = {}): Config {
  const parsed = parseConfig({
    platforms: {
      tg: {
        type: 'telegram',
        token: 't',
        ...(opts.autoRenameThread === undefined ? {} : { autoRenameThread: opts.autoRenameThread }),
      },
    },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
  });
  return { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
}

function rig(
  opts: {
    /** Titles the agent reports during each turn, in order (one array per turn). */
    titlesPerTurn?: string[][];
    autoRenameThread?: boolean;
    canRename?: boolean;
    renameFails?: string;
    /** Reuse an existing store file, to model a daemon restart. */
    storeFile?: string;
  } = {}
) {
  const renames: Array<{ address: ConversationAddress; name: string }> = [];
  const sent: string[] = [];
  const sessions = new Map<string, AgentSession>();
  let turn = 0;

  const agents: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (_input, handlers: AgentStreamHandlers) => {
            for (const t of opts.titlesPerTurn?.[turn] ?? []) handlers.onTitle?.(t);
            turn += 1;
            handlers.onText('done');
          },
          abort: () => {},
          dispose: () => {},
        } as AgentSession;
        sessions.set(conversationId, s);
      }
      return s;
    },
    peek: (id) => sessions.get(id),
    dispose: (id) => void sessions.delete(id),
  };

  const capabilities = {
    thread: true,
    renameThread: opts.canRename ?? true,
    editMessage: true,
    reaction: true,
    reply: true,
    typing: true,
    buttons: true,
    editButtons: true,
    slashCommands: true,
    maxMessageLength: 4096,
  } as unknown as PlatformCapabilities;

  const platform = {
    platform: 'tg',
    platformType: 'telegram',
    capabilities,
    sendMessage: async (address: ConversationAddress, text: string) => {
      sent.push(text);
      return { address, messageId: `m${sent.length}` };
    },
    renameThread: async (address: ConversationAddress, name: string) => {
      if (opts.renameFails) throw new Error(opts.renameFails);
      renames.push({ address, name });
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  let file = opts.storeFile;
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), 'title-rename-'));
    tmpDirs.push(dir);
    file = join(dir, 'conversations.json');
  }
  const store = new ConversationStore(file);
  const daemon = new Daemon(
    config({ ...(opts.autoRenameThread === undefined ? {} : { autoRenameThread: opts.autoRenameThread }) }),
    new Map([['tg', platform]]),
    agents,
    '/tmp/aa-title-rename-test.sock',
    store
  );
  const d = daemon as unknown as { onInbound(m: InboundMessage): void };

  let n = 0;
  const send = async (content: string): Promise<void> => {
    d.onInbound({
      conversation: CONVERSATION,
      messageId: `in${++n}`,
      content,
      timestamp: Date.now(),
      mentionedSelf: true,
    });
    await drain();
  };
  const replies = (): string[] => sent.filter((t) => !t.startsWith('🤖'));
  return { send, renames, replies, store, file, key: 'tg#-1001234567890#99' };
}

describe('renaming a topic to the title the agent generated', () => {
  it('renames the topic the conversation is in', async () => {
    const r = rig({ titlesPerTurn: [['Fix the ask timeout']] });
    await r.send('hello');
    expect(r.renames).toEqual([
      { address: { channel: '-1001234567890', thread: '99' }, name: 'Fix the ask timeout' },
    ]);
  });

  it('remembers what it set, so the name survives a daemon restart unchanged', async () => {
    const r = rig({ titlesPerTurn: [['Fix the ask timeout']] });
    await r.send('hello');
    expect(r.store.conversationTitle(r.key)).toBe('Fix the ask timeout');
  });

  // The harness re-reports its title on many turns, and every rename costs an API call plus a
  // visible "topic renamed" service message in the chat — so an unchanged title must be a no-op.
  it('does not re-issue a rename for a title it already set', async () => {
    const r = rig({ titlesPerTurn: [['Same title'], ['Same title'], ['Same title']] });
    await r.send('one');
    await r.send('two');
    await r.send('three');
    expect(r.renames).toHaveLength(1);
  });

  it('follows the title when it genuinely changes', async () => {
    const r = rig({ titlesPerTurn: [['First guess'], ['Sharper title']] });
    await r.send('one');
    await r.send('two');
    expect(r.renames.map((x) => x.name)).toEqual(['First guess', 'Sharper title']);
  });

  // A restart reattaches every conversation it has on disk. Without the persisted title it would
  // rename all of them to the name they already have, on the first turn after coming back.
  it('does not rename again after a restart when the title has not moved', async () => {
    const first = rig({ titlesPerTurn: [['Stable title']] });
    await first.send('hello');
    expect(first.renames).toHaveLength(1);

    const second = rig({ titlesPerTurn: [['Stable title']], storeFile: first.file });
    await second.send('hello again');
    expect(second.renames).toHaveLength(0);
  });

  it('takes the last title when a turn reports several', async () => {
    const r = rig({ titlesPerTurn: [['draft', 'revised', 'final']] });
    await r.send('hello');
    expect(r.renames.map((x) => x.name)).toEqual(['draft', 'revised', 'final']);
    expect(r.store.conversationTitle(r.key)).toBe('final');
  });
});

describe('when it must leave the name alone', () => {
  it('does nothing when autoRenameThread is off', async () => {
    const r = rig({ titlesPerTurn: [['Fix the ask timeout']], autoRenameThread: false });
    await r.send('hello');
    expect(r.renames).toHaveLength(0);
    expect(r.store.conversationTitle(r.key)).toBeUndefined();
  });

  it('does nothing on a platform that cannot rename a lane', async () => {
    const r = rig({ titlesPerTurn: [['Fix the ask timeout']], canRename: false });
    await r.send('hello');
    expect(r.renames).toHaveLength(0);
  });

  // A cosmetic failure must not cost the user their answer. This is the assertion that matters
  // most in the file: the reply still lands.
  it('answers the turn normally when the rename is rejected', async () => {
    const r = rig({
      titlesPerTurn: [['Fix the ask timeout']],
      renameFails: 'Telegram API error 400: TOPIC_NOT_MODIFIED',
    });
    await r.send('hello');
    expect(r.replies().join('')).toContain('done');
    // Not recorded as done, so the next title change gets another chance.
    expect(r.store.conversationTitle(r.key)).toBeUndefined();
  });

  it('retries on the next turn after a failure, rather than giving up on the conversation', async () => {
    const failing = rig({ titlesPerTurn: [['Try one']], renameFails: 'nope' });
    await failing.send('hello');
    expect(failing.store.conversationTitle(failing.key)).toBeUndefined();

    const working = rig({ titlesPerTurn: [['Try one']], storeFile: failing.file });
    await working.send('hello again');
    expect(working.renames.map((x) => x.name)).toEqual(['Try one']);
  });
});

describe('/title', () => {
  it('renames on demand and says so', async () => {
    const r = rig();
    await r.send('/title 我自己起的名字');
    expect(r.renames.map((x) => x.name)).toEqual(['我自己起的名字']);
    expect(r.replies().at(-1)).toContain('我自己起的名字');
  });

  it('pins the name against the agent, which would otherwise rename it back', async () => {
    const r = rig({ titlesPerTurn: [['Agent title'], ['Agent title']] });
    await r.send('hello'); // the agent names it
    await r.send('/title Mine');
    await r.send('hello again'); // the agent reports its title again
    // Without the pin the third entry would be 'Agent title' — an explicit command undone by the
    // next turn, which reads as a broken command whatever the rename policy says.
    expect(r.renames.map((x) => x.name)).toEqual(['Agent title', 'Mine']);
    expect(r.store.titlePinned(r.key)).toBe(true);
  });

  it('survives a restart still pinned', async () => {
    const first = rig();
    await first.send('/title Mine');

    const second = rig({ titlesPerTurn: [['Agent title']], storeFile: first.file });
    await second.send('hello');
    expect(second.renames).toHaveLength(0);
  });

  it('hands naming back with /title auto, keeping the current name until the agent moves it', async () => {
    // Only ONE real turn runs here — `/title` is answered by the gateway and never reaches the
    // agent, so it does not consume an entry from titlesPerTurn.
    const r = rig({ titlesPerTurn: [['Agent title']] });
    await r.send('/title Mine');
    await r.send('/title auto');
    expect(r.replies().at(-1)).toContain('Handing naming back');
    expect(r.store.titlePinned(r.key)).toBe(false);

    await r.send('hello'); // the agent now gets to name it
    expect(r.renames.map((x) => x.name)).toEqual(['Mine', 'Agent title']);
  });

  it('says naming is already automatic when it is', async () => {
    const r = rig();
    await r.send('/title auto');
    expect(r.replies().at(-1)).toContain('already follows');
  });

  it('reports the name it last set when asked with no argument', async () => {
    const r = rig();
    await r.send('/title Some name');
    await r.send('/title');
    expect(r.replies().at(-1)).toContain('Some name');
    expect(r.replies().at(-1)).toContain('pinned');
  });

  it('says it has named nothing when it has not', async () => {
    const r = rig();
    await r.send('/title');
    expect(r.replies().at(-1)).toContain('have not named');
  });

  // Unlike the automatic path, an explicit command gets an explicit reason — a silent no-op on a
  // command the user typed reads as a broken command.
  it('explains a rejection instead of failing silently', async () => {
    const r = rig({ renameFails: 'Telegram API error 400: not a forum chat' });
    await r.send('/title Nope');
    expect(r.replies().at(-1)).toContain('Could not rename');
    expect(r.replies().at(-1)).toContain('not a forum chat');
  });

  it('explains that the platform cannot do it, rather than pretending it worked', async () => {
    const r = rig({ canRename: false });
    await r.send('/title Nope');
    expect(r.replies().at(-1)).toContain('cannot rename');
  });
});
