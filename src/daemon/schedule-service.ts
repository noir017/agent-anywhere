import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config/schema.js';
import type { ConversationAddress, ConversationRef } from '../core/conversation.js';
import {
  bashResultText,
  bashStatus,
  buildTask,
  formatInZone,
  nextRunOf,
  runNoticeText,
  taskCardText,
  taskExpiredText,
  taskView,
  type NewTaskInput,
  type ScheduleTask,
} from '../core/schedule.js';
import type { SoloOutcome } from '../core/inbound-merger.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { ConversationId } from '../types.js';
import type { ScheduleListResult, ScheduleTaskView } from '../ipc/protocol.js';
import type { ConversationRegistry } from './conversation.js';
import { runBashCommand } from './schedule-bash.js';
import type { ScheduleStore } from './schedule-store.js';
import { Scheduler, type ScheduleRunResult } from './scheduler.js';

/**
 * Scheduled tasks, wired to the rest of the daemon: how a run is carried out (a bash process, or a
 * turn in a conversation), what the agent's `schedule` commands do, and the cards posted when a
 * task changes. Its own file so daemon.ts stays the switchboard it is; the decisions are
 * core/schedule.ts and the timing is scheduler.ts.
 *
 * Every run posts before it does anything visible — a notice for an agent run, the result for a
 * bash one — so output that arrives unasked always says which task produced it.
 */

/** What the service needs from the registry: the scheduled-run entry points and a few read views. */
type Registry = Pick<
  ConversationRegistry,
  | 'conversationAt'
  | 'runScheduledPrompt'
  | 'openScheduledConversation'
  | 'releaseScheduled'
  | 'boundAgentOf'
  | 'laneFor'
  | 'platformFor'
  | 'workdirOf'
>;

export class ScheduleService {
  readonly scheduler: Scheduler;
  private readonly defaultTz: string;

  constructor(
    private readonly config: Config,
    private readonly platforms: Map<string, PlatformAdapter>,
    private readonly registry: Registry,
    private readonly clock: { now(): number; schedule(fn: () => void, ms: number): () => void },
    store: ScheduleStore,
    /** `<configDir>/schedule-runs` — one directory of bash logs per task. */
    private readonly runsDir: string
  ) {
    // The daemon's own zone (TZ, else the host's) is what "8 o'clock" means to whoever set it up.
    this.defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this.scheduler = new Scheduler(store, clock, {
      run: (task, planned, signal) => this.run(task, planned, signal),
      notify: (task) => this.post(task.target.platform, targetAddress(task), taskExpiredText(task), 'expiry notice'),
    });
  }

  // ─────────────────────────────── the agent's commands ───────────────────────────────

  /** `schedule add`. Throws a sentence the agent can act on when the task is refused. */
  add(input: NewTaskInput, caller: ConversationId, target: { platform: string; address: ConversationAddress }): ScheduleTaskView {
    const from = {
      key: caller,
      platform: this.registry.platformFor(caller) ?? target.platform,
      agent: this.registry.boundAgentOf(caller) ?? this.config.routing.default,
      ...optional('cwd', this.registry.workdirOf(caller)),
    };
    const targetConversation = this.registry.conversationAt(target.platform, target.address);
    const built = buildTask(input, {
      now: this.clock.now(),
      id: this.newId(),
      defaultTz: this.defaultTz,
      agents: this.config.agents.map((a) => a.id),
      from,
      target,
      ...(targetConversation ? { targetConversation } : {}),
    });
    if (!built.ok) throw new Error(built.error);
    this.scheduler.add(built.task);
    this.card(caller, built.task, 'registered');
    return taskView(built.task, this.clock.now(), { detail: true, here: caller });
  }

  list(caller: ConversationId | undefined, id?: string): ScheduleListResult {
    const now = this.clock.now();
    if (id !== undefined) {
      const task = this.scheduler.get(id);
      if (!task) throw new Error(`no scheduled task #${id}; \`agent-anywhere schedule list\` shows them all`);
      return { tasks: [taskView(task, now, { detail: true, here: caller })] };
    }
    return { tasks: this.scheduler.list().map((t) => taskView(t, now, { here: caller })) };
  }

  /**
   * remove / pause / resume / run. Throws when nothing changed, with the reason. `announce` posts the
   * task's card in the caller's conversation — on for the agent's commands (the user should read
   * what changed in the daemon's words), off for the `/setting` menu, whose own message already says.
   */
  op(
    id: string,
    op: 'remove' | 'pause' | 'resume' | 'run',
    caller: ConversationId | undefined,
    announce = true
  ): ScheduleTaskView {
    const now = this.clock.now();
    const say = (task: ScheduleTask, verb: string): void => {
      if (caller && announce) this.card(caller, task, verb);
    };
    if (op === 'remove') {
      const removed = this.scheduler.remove(id);
      if (!removed) throw new Error(`no scheduled task #${id}`);
      say(removed, 'deleted');
      return taskView(removed, now, { here: caller });
    }
    const result = op === 'run' ? this.scheduler.runNow(id) : this.scheduler.setPaused(id, op === 'pause');
    if (typeof result === 'string') throw new Error(result);
    if (op !== 'run') say(result, op === 'pause' ? 'paused' : 'resumed');
    return taskView(result, now, { here: caller });
  }

  /** One task by id, for the menu's re-read at every click. */
  get(id: string): ScheduleTask | undefined {
    return this.scheduler.get(id);
  }

  now(): number {
    return this.clock.now();
  }

  /** Every task, for `/setting schedule`. */
  tasks(): ScheduleTask[] {
    return this.scheduler.list();
  }

  /**
   * Whether a task that can still run posts into the conversation at `ref` — what keeps the web
   * UI from evicting that topic (`PlatformAdapter.useScheduleLookup`).
   *
   * Paused counts: resuming it would otherwise find its topic gone. Expired and done do not; an
   * expired task has already posted its notice and runs no more.
   */
  targets(ref: ConversationRef): boolean {
    return this.scheduler
      .list()
      .some(
        (t) =>
          (t.state === 'active' || t.state === 'paused') &&
          t.target.platform === ref.platform &&
          t.target.channel === ref.channel &&
          t.target.thread === ref.thread
      );
  }

  nextRun(task: ScheduleTask): number | undefined {
    return nextRunOf(task, this.clock.now());
  }

  // ─────────────────────────────── running ───────────────────────────────

  private async run(task: ScheduleTask, planned: number, signal: AbortSignal): Promise<ScheduleRunResult> {
    const platform = this.platforms.get(task.target.platform);
    if (!platform) return { status: 'failed', error: `platform instance "${task.target.platform}" is not configured any more` };
    try {
      if (task.run.kind === 'bash') return await this.runBash(task, task.run, platform, planned, signal);
      return await this.runAgent(task, task.run, platform, planned);
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async runBash(
    task: ScheduleTask,
    run: Extract<ScheduleTask['run'], { kind: 'bash' }>,
    platform: PlatformAdapter,
    planned: number,
    signal: AbortSignal
  ): Promise<ScheduleRunResult> {
    const started = this.clock.now();
    const stamp = new Date(planned).toISOString().replace(/[:.]/g, '-');
    const r = await runBashCommand({
      command: run.command,
      ...optional('cwd', run.cwd),
      timeoutMs: run.timeoutMs,
      logDir: path.join(this.runsDir, task.id),
      stamp,
      signal,
    });
    const outcome = { ...r, durationMs: this.clock.now() - started };
    const { text, attach } = bashResultText(task, outcome, run.timeoutMs);
    const address = targetAddress(task);
    await platform.sendMessage(address, text).catch((e) => warn('bash result', e));
    if (attach && r.logFile) {
      await platform.sendFile(address, { path: r.logFile, name: `${task.id}-${stamp}.log` }).catch((e) => warn('bash log', e));
    }
    const { status, error } = bashStatus(outcome, run.timeoutMs);
    return { status, ...optional('exitCode', r.exitCode ?? undefined), ...optional('error', error) };
  }

  private async runAgent(
    task: ScheduleTask,
    run: Extract<ScheduleTask['run'], { kind: 'agent' }>,
    platform: PlatformAdapter,
    planned: number
  ): Promise<ScheduleRunResult> {
    // Sent exactly as it was registered, with nothing marking it as scheduled: the agent wrote this
    // prompt itself when it added the task, so it already says what to do, and a gateway preamble
    // would be the only text in the conversation the agent did not get from a person or itself.
    // The user is told the run started by its own notice (runNoticeText), outside the agent's view.
    const prompt = run.prompt;
    if (run.session === 'fixed') {
      const key = task.conversation!;
      const bound = this.registry.boundAgentOf(key);
      if (bound !== undefined && bound !== run.agent) {
        // A topic keeps its agent; after /new the user may have given it another on purpose.
        const why = `this topic is now answered by ${bound}, not ${run.agent}`;
        await platform.sendMessage(targetAddress(task), `⏰ \`#${task.id}\` **${task.name}** skipped — ${why}.`).catch((e) => warn('skip notice', e));
        return { status: 'failed', error: why };
      }
      await platform.sendMessage(targetAddress(task), runNoticeText(task, planned)).catch((e) => warn('run notice', e));
      return toResult(
        await this.registry.runScheduledPrompt({ key, platform: task.target.platform, address: targetAddress(task), agentId: run.agent, prompt })
      );
    }

    const opened = await this.registry.openScheduledConversation({
      platform: task.target.platform,
      address: targetAddress(task),
      agentId: run.agent,
      title: `⏰ ${task.name} · ${formatInZone(planned, task.when.tz)}`,
      ...optional('cwd', run.cwd),
      ephemeralKey: `schedule#${task.id}#${planned}`,
    });
    try {
      await platform.sendMessage(opened.address, runNoticeText(task, planned)).catch((e) => warn('run notice', e));
      return toResult(
        await this.registry.runScheduledPrompt({ key: opened.key, platform: task.target.platform, address: opened.address, agentId: run.agent, prompt })
      );
    } finally {
      if (opened.ephemeral) this.registry.releaseScheduled(opened.key);
    }
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  /** Post the task's card where the change was asked for — the daemon's word, not the agent's. */
  card(conversation: ConversationId, task: ScheduleTask, verb: string): void {
    const lane = this.registry.laneFor(conversation);
    if (!lane) return;
    this.post(lane.platformId, lane.address, taskCardText(task, verb, this.clock.now()), `${verb} card`);
  }

  private post(platformId: string, address: ConversationAddress, text: string, what: string): void {
    void this.platforms
      .get(platformId)
      ?.sendMessage(address, text)
      .catch((e) => warn(what, e));
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(3).toString('hex');
      if (!this.scheduler.get(id)) return id;
    }
  }
}

function targetAddress(task: ScheduleTask): ConversationAddress {
  return task.target.thread ? { channel: task.target.channel, thread: task.target.thread } : { channel: task.target.channel };
}

function toResult(r: SoloOutcome | { refused: string }): ScheduleRunResult {
  return typeof r === 'string' ? { status: r } : { status: 'failed', error: r.refused };
}

/** `{ [key]: value }` when value is defined, else `{}` — for optional fields under strict types. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function warn(what: string, e: unknown): void {
  console.warn(`[schedule] failed to post the ${what}:`, e instanceof Error ? e.message : e);
}
