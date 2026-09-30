import { formatButtonId, parseButtonId } from './button-id.js';
import { truncateLabel } from './paging.js';
import {
  describeLastRun,
  describeRun,
  describeWhen,
  formatInZone,
  nextSuffix,
  targetId,
  taskListText,
  type ScheduleTask,
} from './schedule.js';

/**
 * `/setting` → ⏰ Scheduled tasks, as data: the list, one task, the delete confirmation, and the
 * button ids between them. The daemon holds the menu's state and carries the clicks out; this
 * module decides what each level says and offers, so the typed and tapped surfaces cannot disagree.
 *
 * Reached from the settings screen rather than being a row of it, because every settings row is a
 * config.yaml value with a parser, a location and an ack (core/settings.ts), and a task list is none
 * of those. The entry button edits the settings message into this menu, and "◀ Settings" edits it
 * back — one message, like every other menu here.
 *
 * Same three rules as the other menus: not one-shot, a frozen snapshot of ids that button indices
 * point into, and the task re-read at every click (so a task deleted meanwhile says so instead of
 * being acted on).
 */

/** Settings list → schedule list: `sco:<reqId>:0` (posted by the settings menu). */
export const SCHEDULE_OPEN_PREFIX = 'sco:';
/** List → one task: `sct:<reqId>:<index into the frozen id list>`. */
export const SCHEDULE_TASK_PREFIX = 'sct:';
/** An action on the open task: `sca:<reqId>:<ScheduleAction index>`. */
export const SCHEDULE_ACTION_PREFIX = 'sca:';

/** Index = the number in the `sca:` id. Append only: ids of menus already posted carry these. */
const ACTIONS = ['pause', 'resume', 'delete', 'confirm-delete', 'back', 'settings'] as const;
export type ScheduleMenuAction = (typeof ACTIONS)[number];

export type ScheduleMenuClick =
  | { kind: 'open'; reqId: string }
  | { kind: 'task'; reqId: string; index: number }
  | { kind: 'action'; reqId: string; action: ScheduleMenuAction };

export function scheduleOpenButtonId(reqId: string): string {
  return formatButtonId(SCHEDULE_OPEN_PREFIX, reqId, 0);
}

function actionId(reqId: string, action: ScheduleMenuAction): string {
  return formatButtonId(SCHEDULE_ACTION_PREFIX, reqId, ACTIONS.indexOf(action));
}

export function parseScheduleButtonId(buttonId: string): ScheduleMenuClick | null {
  const open = parseButtonId(buttonId, SCHEDULE_OPEN_PREFIX);
  if (open) return { kind: 'open', reqId: open.reqId };
  const task = parseButtonId(buttonId, SCHEDULE_TASK_PREFIX);
  if (task) return { kind: 'task', reqId: task.reqId, index: task.n };
  const act = parseButtonId(buttonId, SCHEDULE_ACTION_PREFIX);
  const action = act ? ACTIONS[act.n] : undefined;
  if (act && action) return { kind: 'action', reqId: act.reqId, action };
  return null;
}

/** The entry button's label on the settings screen. */
export function scheduleEntryLabel(tasks: readonly ScheduleTask[]): string {
  const active = tasks.filter((t) => t.state === 'active').length;
  return truncateLabel(`⏰ Scheduled tasks · ${active} active${tasks.length > active ? `, ${tasks.length - active} other` : ''}`);
}

/** Tasks offered as buttons; the rest are listed in the text and managed by typing. */
export const SCHEDULE_MENU_MAX = 20;

const STATE_MARK: Record<ScheduleTask['state'], string> = { active: '', paused: '⏸ ', expired: '⌛ ', done: '✔ ' };

export interface ScheduleMenuView {
  text: string;
  buttons: Array<{ id: string; label: string }>;
}

/** The list level. `ids` is the frozen snapshot the task buttons index into. */
export function buildScheduleListMenu(reqId: string, tasks: readonly ScheduleTask[], now: number): ScheduleMenuView & { ids: string[] } {
  const shown = tasks.slice(0, SCHEDULE_MENU_MAX);
  const buttons = shown.map((t, i) => ({
    id: formatButtonId(SCHEDULE_TASK_PREFIX, reqId, i),
    label: truncateLabel(`${STATE_MARK[t.state]}#${t.id} ${t.name}`),
  }));
  buttons.push({ id: actionId(reqId, 'settings'), label: '◀ Settings' });
  let text = taskListText(tasks, now);
  if (tasks.length > 0) text += '\n\nTap one to pause, resume or delete it.';
  if (tasks.length > SCHEDULE_MENU_MAX) {
    text += `\n${tasks.length - SCHEDULE_MENU_MAX} more not shown as buttons — \`/setting schedule pause|resume|delete <id>\` works for any.`;
  }
  return { text, buttons, ids: shown.map((t) => t.id) };
}

/** One task's level: what it is, and what can be done to it in its state. */
export function buildScheduleTaskMenu(reqId: string, task: ScheduleTask, now: number): ScheduleMenuView {
  const tz = task.when.tz;
  const what = task.run.kind === 'bash' ? task.run.command : task.run.prompt;
  const lines = [
    `⏰ \`#${task.id}\` **${task.name}** — ${task.state}`,
    `• When: ${describeWhen(task.when)}${nextSuffix(task, now)}`,
    `• Runs: ${describeRun(task.run)}${task.expiresAt !== undefined ? ` · until ${formatInZone(task.expiresAt, tz)}` : ''}`,
    `• Posts to: \`${targetId(task.target)}\``,
    `• Last run: ${describeLastRun(task)} · ${task.runs} run(s) so far`,
    `• ${task.run.kind === 'bash' ? 'Command' : 'Prompt'}: ${what.length <= 300 ? what : `${what.slice(0, 299)}…`}`,
  ];
  const buttons: Array<{ id: string; label: string }> = [];
  if (task.state === 'active') buttons.push({ id: actionId(reqId, 'pause'), label: '⏸ Pause' });
  if (task.state === 'paused') buttons.push({ id: actionId(reqId, 'resume'), label: '▶ Resume' });
  buttons.push({ id: actionId(reqId, 'delete'), label: '🗑 Delete' });
  buttons.push({ id: actionId(reqId, 'back'), label: '◀ Back' });
  return { text: lines.join('\n'), buttons };
}

/** Delete asks once more: the task is gone for good, and a mis-tap on a phone is easy. */
export function buildScheduleDeleteConfirm(reqId: string, task: ScheduleTask): ScheduleMenuView {
  return {
    text: `Delete \`#${task.id}\` **${task.name}**? It stops running and cannot be brought back.`,
    buttons: [
      { id: actionId(reqId, 'confirm-delete'), label: '🗑 Yes, delete it' },
      { id: actionId(reqId, 'back'), label: 'Cancel' },
    ],
  };
}

export function scheduleMenuExpiredText(): string {
  return 'This menu has expired (the gateway restarted, or a newer one was opened). Send `/setting schedule` again.';
}
