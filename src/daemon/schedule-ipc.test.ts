import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from './daemon.js';
import { ConversationStore } from './conversation-store.js';
import { ScheduleStore } from './schedule-store.js';
import { parseConfig } from '../config/schema.js';
import { callDaemon } from '../ipc/client.js';
import type { IpcAction, ScheduleListResult, ScheduleTaskView } from '../ipc/protocol.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { InboundMessage } from '../types.js';

/**
 * Scheduled tasks end to end: registered over the real socket the way an agent does it, then run
 * (`schedule run`, so no test waits on a clock) through the real registry and merger into stub
 * platforms. What is asserted is WHERE things land — the card, the notice, the output, the turn —
 * because every mode differs from the others exactly there.
 */

const parsed = parseConfig({
  platforms: { tg: { type: 'telegram', token: 't' }, web: { type: 'webui', token: 'w' } },
  agents: [
    { id: 'cc', harness: 'claude' },
    { id: 'oc', harness: 'opencode' },
  ],
  routing: { default: 'cc' },
});
const cfg = { ...parsed, inbound: { ...parsed.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };

type Sent = { platform: string; address: { channel: string; thread?: string }; text: string };
type Menu = { text: string; buttons: Array<{ id: string; label: string }> };

function adapter(
  id: string,
  type: string,
  sent: Sent[],
  opts: { thread: boolean; buttons?: boolean; menus?: Menu[] }
): PlatformAdapter & { threads: string[] } {
  const threads: string[] = [];
  const menus = opts.menus ?? [];
  return {
    platform: id,
    platformType: type,
    threads,
    capabilities: {
      thread: opts.thread,
      editMessage: true,
      buttons: opts.buttons ?? false,
      editButtons: opts.buttons ?? false,
      reaction: false,
      reply: false,
      typing: false,
      maxMessageLength: 4096,
    },
    sendButtons: async (address: Sent['address'], text: string, buttons: Menu['buttons']) => {
      menus.push({ text, buttons });
      return { address, messageId: 'menu' };
    },
    editButtons: async (_ref: unknown, text: string, buttons: Menu['buttons']) => void menus.push({ text, buttons }),
    sendMessage: async (address: Sent['address'], text: string) => {
      sent.push({ platform: id, address, text });
      return { address, messageId: `${id}-${sent.length}` };
    },
    sendFile: async (address: Sent['address'], file: { name?: string }) => {
      sent.push({ platform: id, address, text: `[file ${file.name}]` });
      return { address, messageId: 'f' };
    },
    createThread: async (ref: { address: { channel: string } }, name: string) => {
      threads.push(name);
      return { address: { channel: ref.address.channel, thread: `new${threads.length}` } };
    },
    renameThread: async () => {},
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
    stop: async () => {},
  } as unknown as PlatformAdapter & { threads: string[] };
}

const dirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-schedule-'));
  dirs.push(dir);
  const socket = path.join(dir, 'd.sock');
  const sent: Sent[] = [];
  const tokens: string[] = [];
  const turns: Array<{ conversation: string; agent: string; prompt: string }> = [];
  const disposed: string[] = [];
  const sessions = new Map<string, AgentSession>();
  const agents: AgentFactory = {
    getOrCreate(conversationId, agentId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input: { prompt: string; sessionToken: string }) => {
            tokens.push(input.sessionToken);
            turns.push({ conversation: conversationId, agent: agentId, prompt: input.prompt });
          },
          abort: () => {},
          dispose: () => {},
        } as unknown as AgentSession;
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
  const tg = adapter('tg', 'telegram', sent, { thread: false });
  const menus: Menu[] = [];
  const web = adapter('web', 'webui', sent, { thread: true, buttons: true, menus });
  const daemon = new Daemon(
    cfg,
    new Map<string, PlatformAdapter>([
      ['tg', tg],
      ['web', web],
    ]),
    agents,
    socket,
    new ConversationStore(path.join(dir, 'conversations.json')),
    undefined,
    { store: new ScheduleStore(path.join(dir, 'schedules.json')), runsDir: path.join(dir, 'runs') }
  );
  daemons.push(daemon);
  const internals = daemon as unknown as { ipc: { start(): Promise<void> }; schedules: { scheduler: { start(): void } } };
  await internals.ipc.start();
  internals.schedules.scheduler.start();

  let n = 0;
  const inbound = async (conversation: InboundMessage['conversation'], content: string): Promise<void> => {
    (daemon as unknown as { onInbound: (m: InboundMessage) => void }).onInbound({ conversation, messageId: `in_${++n}`, content, timestamp: Date.now() });
    await settle();
  };
  const call = async (action: IpcAction) => callDaemon(socket, action, tokens[0]!);
  /** Tap a button on the last menu by its label. */
  const tap = async (label: string | RegExp): Promise<void> => {
    const menu = menus.at(-1)!;
    const button = menu.buttons.find((b) => (typeof label === 'string' ? b.label === label : label.test(b.label)));
    if (!button) throw new Error(`no button ${label} on: ${menu.buttons.map((b) => b.label).join(' | ')}`);
    (daemon as unknown as { onButton: (ev: unknown) => void }).onButton({ buttonId: button.id, conversation: WEB, messageId: 'menu' });
    await settle(20);
  };
  return { dir, sent, turns, disposed, tg, web, menus, inbound, call, tap };
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WEB = { platform: 'web', channel: 'main', thread: 't1', kind: 'direct' as const, user: 'u1' };

async function added(r: Awaited<ReturnType<typeof rig>>, action: Extract<IpcAction, { kind: 'schedule-add' }>): Promise<ScheduleTaskView> {
  const resp = await r.call(action);
  if (!resp.ok) throw new Error(resp.error);
  return (resp.data as { task: ScheduleTaskView }).task;
}

describe('schedule over IPC', () => {
  it('registers a task and posts the gateway\'s own card where the user is talking', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    r.sent.length = 0;
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'morning brief', session: 'new', name: 'brief' });
    expect(task).toMatchObject({ name: 'brief', state: 'active', runs: 'cc · new session each run', target: 'web:main/t1', prompt: 'morning brief' });
    await settle();
    const card = r.sent.find((s) => s.text.includes('Scheduled task registered'))!;
    expect(card.address).toEqual({ channel: 'main', thread: 't1' });
    expect(card.text).toContain(`#${task.id}`);
    expect(fs.existsSync(path.join(r.dir, 'schedules.json'))).toBe(true);
  });

  it('refuses a fixed-session task for another agent, with the way out', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const resp = await r.call({ kind: 'schedule-add', cron: '*/30 * * * *', prompt: 'x', agent: 'oc' });
    expect(resp.ok).toBe(false);
    expect((resp as { error: string }).error).toMatch(/answered by cc.*--session new to run oc/);
  });

  it('bash: runs the command and posts exit code and output to the target', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', at: '+1h', bash: 'echo scheduled-hello', channelId: 'tg:586' });
    expect(task.target).toBe('tg:586');
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle(400);
    const result = r.sent.find((s) => s.platform === 'tg')!;
    expect(result.address).toEqual({ channel: '586' });
    expect(result.text).toMatch(/✅ exit 0/);
    expect(result.text).toContain('scheduled-hello');
    expect(r.turns).toHaveLength(1); // only the user's own turn; no agent was involved
  });

  it('fixed session: the prompt is a turn in the registering conversation, after a notice', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '*/30 * * * *', prompt: 'check the build' });
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#t1', agent: 'cc' });
    expect(r.turns.at(-1)!.prompt).toMatch(/^\[⏰ scheduled task "check the build" #\w+ · .*\]\ncheck the build/);
    expect(r.sent[0]!.text).toMatch(/⏰ Scheduled task `#\w+` \*\*check the build\*\*/);
  });

  it('new session: a fresh topic per run where the platform can open one', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', agent: 'oc', name: 'brief' });
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    expect(r.web.threads).toEqual([expect.stringMatching(/^\[oc\] ⏰ brief · /)]);
    expect(r.turns.at(-1)).toMatchObject({ conversation: 'web#main#new1', agent: 'oc' });
    // The conversation is kept: the user can carry on in the new topic.
    expect(r.disposed).not.toContain('web#main#new1');
  });

  it('new session on a platform with no threads: posted into the chat, then forgotten', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', prompt: 'brief', session: 'new', channelId: 'tg:586' });
    r.sent.length = 0;
    await r.call({ kind: 'schedule-op', id: task.id, op: 'run' });
    await settle();
    const turn = r.turns.at(-1)!;
    expect(turn.conversation).toMatch(new RegExp(`^schedule#${task.id}#`));
    expect(r.sent[0]).toMatchObject({ platform: 'tg', address: { channel: '586' } });
    expect(r.disposed).toContain(turn.conversation);
  });

  it('list, pause and rm answer with the task and post a card for each change', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true' });
    const list = await r.call({ kind: 'schedule-list' });
    expect((list as { data: ScheduleListResult }).data.tasks).toEqual([expect.objectContaining({ id: task.id, here: true })]);

    r.sent.length = 0;
    const paused = await r.call({ kind: 'schedule-op', id: task.id, op: 'pause' });
    expect((paused as { data: { task: ScheduleTaskView } }).data.task.state).toBe('paused');
    await r.call({ kind: 'schedule-op', id: task.id, op: 'remove' });
    await settle();
    expect(r.sent.map((s) => s.text.split(' — ')[0])).toEqual(['⏰ Scheduled task paused', '⏰ Scheduled task deleted']);
    const gone = await r.call({ kind: 'schedule-op', id: task.id, op: 'pause' });
    expect(gone).toMatchObject({ ok: false, error: `no scheduled task #${task.id}` });
  });
});

/**
 * `/setting` → ⏰ Scheduled tasks. One message throughout: the entry button hands the settings menu
 * over, and every level after is an edit of it. Deleting takes two taps.
 */
describe('scheduled tasks under /setting', () => {
  const TG_DM = { platform: 'tg', channel: '586', kind: 'direct' as const, user: 'u1' };

  it('lists, pauses and deletes from the menu, then goes back to the settings', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', name: 'backup' });
    await r.inbound(WEB, '/setting');
    expect(r.menus.at(-1)!.buttons.at(-1)!.label).toBe('⏰ Scheduled tasks · 1 active');

    await r.tap(/^⏰ Scheduled tasks/);
    expect(r.menus.at(-1)!.text).toContain('backup');
    await r.tap(`#${task.id} backup`);
    expect(r.menus.at(-1)!.text).toContain('`0 8 * * *` (');
    r.sent.length = 0;

    await r.tap('⏸ Pause');
    expect(r.menus.at(-1)!.text).toMatch(/^⏸ Paused `#\w+` \*\*backup\*\*\./);
    expect(r.menus.at(-1)!.buttons.map((b) => b.label)).toEqual(['▶ Resume', '🗑 Delete', '◀ Back']);
    expect(r.sent).toEqual([]); // the menu is the answer; no second card beside it

    await r.tap('🗑 Delete');
    expect(r.menus.at(-1)!.text).toMatch(/^Delete `#\w+` \*\*backup\*\*\?/);
    await r.tap('🗑 Yes, delete it');
    expect(r.menus.at(-1)!.text).toMatch(/^🗑 Deleted `#\w+` \*\*backup\*\*\.\n\nNo scheduled tasks/);
    const list = await r.call({ kind: 'schedule-list' });
    expect((list as { data: ScheduleListResult }).data.tasks).toEqual([]);

    await r.tap('◀ Settings');
    expect(r.menus.at(-1)!.text).toMatch(/^Settings — /);
  });

  it('cancel on the confirmation goes back to the task without deleting it', async () => {
    const r = await rig();
    await r.inbound(WEB, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', name: 'keep' });
    await r.inbound(WEB, '/setting schedule');
    await r.tap(`#${task.id} keep`);
    await r.tap('🗑 Delete');
    await r.tap('Cancel');
    expect(r.menus.at(-1)!.buttons.map((b) => b.label)).toContain('⏸ Pause');
    expect((await r.call({ kind: 'schedule-list' }) as { data: ScheduleListResult }).data.tasks).toHaveLength(1);
  });

  it('works by typing where there are no buttons, answering with the task card', async () => {
    const r = await rig();
    await r.inbound(TG_DM, 'hello');
    const task = await added(r, { kind: 'schedule-add', cron: '0 8 * * *', bash: 'true', name: 'typed' });
    r.sent.length = 0;
    await r.inbound(TG_DM, '/setting schedule');
    expect(r.sent.at(-1)!.text).toMatch(/\*\*Scheduled tasks\*\*\n`#\w+` \*\*typed\*\*/);
    await r.inbound(TG_DM, `/setting schedule pause ${task.id}`);
    expect(r.sent.at(-1)!.text).toMatch(/^⏰ Scheduled task paused — `#\w+` \*\*typed\*\*/);
    await r.inbound(TG_DM, '/setting');
    expect(r.sent.at(-1)!.text).toContain('⏰ `/setting schedule` — 1 scheduled task(s)');
  });
});
