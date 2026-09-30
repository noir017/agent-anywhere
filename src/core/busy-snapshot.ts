import { formatRuntimeFooter } from './runtime-footer.js';

/**
 * The gateway's own answer to a session query (`/usage`, `/context`) asked while the conversation
 * is busy — pure text, no clock (elapsed time is passed in).
 *
 * Exists because forwarding the command is what the translation table would do, and a forwarded
 * command interrupts the running turn (see GenericCommand.query in command-translate.ts). So the
 * answer is built from what the gateway already holds: the latest context snapshot and the last
 * cost the harness reported. It is deliberately LESS than the harness's own answer — claude's
 * native `/usage` adds per-model tokens, cache and API time, none of which reaches the gateway —
 * and the note says so, so nobody mistakes the snapshot for the full report.
 */

export interface UsageSnapshotInput {
  /** Display name of the agent answering the conversation. */
  agent: string;
  /** Latest context snapshot; absent when the harness has reported none yet. */
  usage?: { used: number; size: number };
  /** Cumulative session cost as of the last finished turn; absent when never reported. */
  cost?: { amount: number; currency: string };
  /** How long the running turn has been going; absent while it is still being collected. */
  runningForMs?: number;
}

/** `$30.64` for USD (the only currency seen so far), `12.50 EUR` otherwise. */
export function formatCost(cost: { amount: number; currency: string }): string {
  const amount = cost.amount.toFixed(2);
  return cost.currency.toUpperCase() === 'USD' ? `$${amount}` : `${amount} ${cost.currency}`;
}

/**
 * `42s`, `4m 12s`, `1h 3m`. Finer than schedule.ts's formatDuration on purpose: that one rounds to
 * whole minutes for a run that is over, while this answers "is it still moving", where 4m and 4m 50s
 * are different answers.
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The `/usage` snapshot body (the busy note is appended separately — see busyNote). */
export function formatUsageSnapshot(input: UsageSnapshotInput): string {
  const lines = [`**Usage** — gateway snapshot of ${input.agent}`];
  const context = input.usage
    ? formatRuntimeFooter({ contextTokens: input.usage.used, contextLength: input.usage.size }, ['context'])
    : '';
  lines.push(`Context: ${context || 'not reported yet'}`);
  // "Not reported" rather than "yet": codex-acp never sends a cost at all, while claude sends one
  // only when a turn finishes, and nothing here can tell the two apart honestly.
  lines.push(
    input.cost
      ? `Cost: ${formatCost(input.cost)} this session, as of the last finished turn`
      : 'Cost: not reported'
  );
  if (input.runningForMs !== undefined) lines.push(`This turn: running ${formatElapsed(input.runningForMs)}`);
  return lines.join('\n');
}

/**
 * The line appended to every busy answer: why the gateway answered, and how to get the harness's
 * own. Worded for both states the caller treats as busy — a running turn, and a batch still in its
 * merge window, which a forwarded command would have been glued onto.
 */
export function busyNote(command: string, agent: string): string {
  return (
    `⏳ ${agent} is busy with a turn, and forwarding /${command} would have interrupted it — so the ` +
    `gateway answered from what it already holds. Send /${command} again once the turn ends for ` +
    `${agent}'s own full answer.`
  );
}
