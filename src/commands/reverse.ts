import os from 'node:os';
import path from 'node:path';
import { encode } from '@toon-format/toon';
import { loadConfig, resolveSocketPath } from '../config/load.js';
import { callDaemon } from '../ipc/client.js';
import { DEFAULT_FETCH_FIELDS } from '../ipc/commands.js';
import type { IpcAction } from '../ipc/protocol.js';
import { ASK_CLIENT_TIMEOUT_MARGIN_MS, DEFAULT_ASK_TIMEOUT_MS } from '../ipc/protocol.js';
import type { InboundMessage } from '../types.js';

/**
 * Per-row content truncation for fetch-messages (AXI §3): keeps a history dump token-bounded.
 * 500 chars covers most chat turns while leaving a clear `…` + help marker when clipped.
 */
const CONTENT_LIMIT = 500;

/** Encode a plain JS value to TOON and write it to stdout (the agent's only data channel). */
function emit(value: unknown): void {
  console.log(encode(value));
}

/**
 * Normalize a user/agent-supplied path to absolute: expand a leading `~`, then
 * path.resolve against the current CWD. This process's CWD is the agent's working dir
 * (set by the daemon when spawning the agent), so the resolved absolute path is the
 * real file as the agent sees it. The daemon's CWD may differ, and the path is later
 * turned into a file:// URL — a relative path or `~` would become a malformed/wrong
 * address like `file://./x.png` on the daemon side, so we must resolve to absolute here.
 */
function resolvePathArg(p: string): string {
  let expanded = p;
  if (p === '~') expanded = os.homedir();
  else if (p.startsWith('~/')) expanded = path.join(os.homedir(), p.slice(2));
  return path.resolve(expanded);
}

/**
 * Normalize the relative/`~` path in a send-file action to absolute (see resolvePathArg).
 * Other actions are returned unchanged.
 */
function normalizeActionPaths(action: IpcAction): IpcAction {
  if (action.kind === 'send-file') {
    return { ...action, path: resolvePathArg(action.path) };
  }
  return action;
}

/**
 * Unified execution for reverse commands: connect back to the daemon. Reused by the
 * cli.ts subcommands. Reached when the agent (via a skill) runs `agent-anywhere send-file ./out.png`.
 *
 * This function is the AXI output boundary: the daemon speaks plain JSON over IPC, and we
 * convert it to token-efficient TOON on stdout here (errors included, so the agent can read them).
 */
export async function runReverse(rawAction: IpcAction): Promise<void> {
  const socket = resolveSocketPath(loadConfig());

  // Resolve send-file paths to absolute here (CWD == agent CWD) to avoid the daemon building
  // file://./x.png (malformed) or a path relative to the daemon CWD (wrong).
  const action = normalizeActionPaths(rawAction);

  // Blocking ask hangs on the daemon side until the user selects/times out, so the
  // client's default 10s isn't enough; use action.timeoutMs (default from the protocol,
  // shared with the daemon) plus a margin so the client doesn't give up before the daemon.
  const clientTimeout =
    action.kind === 'ask'
      ? (action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) + ASK_CLIENT_TIMEOUT_MARGIN_MS
      : undefined;

  const resp = await callDaemon(socket, action, undefined, clientTimeout);
  if (!resp.ok) {
    // AXI §6: errors go to stdout in the same structured format as data, with an actionable hint.
    emit(friendlyError(resp.error, socket));
    process.exitCode = 1;
    return;
  }

  printResult(action, resp.data);
}

/**
 * Render a successful response as TOON on stdout, shaped per command (AXI §1/§2/§9).
 * `ask` is the one exception: its result is the user's chosen label, printed verbatim so
 * the agent can branch on it directly (an empty line means timeout/no-selection).
 */
function printResult(action: IpcAction, data: unknown): void {
  switch (action.kind) {
    case 'ask': {
      const chosen = (data as { chosen?: string | null } | undefined)?.chosen ?? null;
      console.log(chosen ?? '');
      // An empty stdout line is a legitimate answer shape, which makes it a poor way to learn that
      // nobody answered at all — the agent sees the same blank either way and reasonably concludes
      // the command is broken. Say so on stderr, where it cannot corrupt the label on stdout.
      if (chosen === null) {
        const waited = Math.round((action.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS) / 1000);
        console.error(
          `ask: no option was chosen within ${waited}s (the buttons have been withdrawn). ` +
            `The question was delivered — nobody clicked. Ask again in plain text, or retry with ` +
            `--timeout <ms> for longer.`
        );
      }
      return;
    }
    case 'fetch-messages':
      printFetchMessages(action, data);
      return;
    case 'create-thread': {
      const threadId = (data as { threadId?: string } | undefined)?.threadId;
      // Contextual disclosure (AXI §9): the next step is almost always sending into the thread.
      emit({
        threadId: threadId ?? '',
        help: `Send into this thread by passing --channel ${threadId ?? '<threadId>'}.`,
      });
      return;
    }
    case 'send-message':
    case 'reply':
    case 'send-file': {
      // These return a MessageRef; surface messageId so the agent can react/reply/edit/delete it later.
      const messageId = (data as { messageId?: string } | undefined)?.messageId;
      emit(messageId ? { ok: true, messageId } : { ok: true });
      return;
    }
    default:
      // edit-message / react / delete return nothing actionable — a definitive ack is enough.
      emit({ ok: true });
  }
}

/**
 * Shape fetch-messages into a compact TOON table (AXI §1/§2/§3/§4/§5/§9):
 *  - minimal default schema (messageId,userId,content), widenable via --fields;
 *  - per-row content truncation with a count of how many were clipped;
 *  - attachment URLs rendered as a separate `attachments` table (a nested array would break the
 *    main tabular block) when requested, plus a hint when attachments exist but weren't requested;
 *  - a definitive empty state;
 *  - a `count` aggregate plus paging/widening hints when relevant.
 */
function printFetchMessages(
  action: Extract<IpcAction, { kind: 'fetch-messages' }>,
  data: unknown
): void {
  const messages = (data as { messages?: InboundMessage[] } | undefined)?.messages ?? [];

  // AXI §5: state the zero explicitly so the agent doesn't re-run with different flags to verify.
  if (messages.length === 0) {
    emit({ count: 0, note: 'no messages found in this channel' });
    return;
  }

  const requested = action.fields?.length ? action.fields : [...DEFAULT_FETCH_FIELDS];
  const wantAttachments = requested.includes('attachments');
  // `attachments` is rendered as its own table below, so it's not a main-table column; keep at
  // least messageId there as the key that links a row to its attachments.
  let columns = requested.filter((f) => f !== 'attachments');
  if (columns.length === 0) columns = ['messageId'];

  let truncated = 0;
  const rows = messages.map((m) => {
    const row: Record<string, unknown> = {};
    for (const f of columns) {
      if (f === 'content') {
        const c = m.content ?? '';
        if (c.length > CONTENT_LIMIT) {
          truncated++;
          row.content = `${c.slice(0, CONTENT_LIMIT)}…`;
        } else {
          row.content = c;
        }
      } else {
        const v = (m as unknown as Record<string, unknown>)[f];
        row[f] = v ?? '';
      }
    }
    return row;
  });

  const out: Record<string, unknown> = { count: rows.length, messages: rows };

  // Attachment URLs as a separate table, keyed by messageId (AXI §4: spare the agent a follow-up call).
  if (wantAttachments) {
    const atts = messages.flatMap((m) =>
      (m.attachments ?? []).map((a) => ({
        messageId: m.messageId,
        type: a.type,
        url: a.url,
        name: a.name ?? '',
      }))
    );
    out.attachments = atts.length ? atts : 'none'; // AXI §5: definitive empty state
  }

  const help: string[] = [];
  if (action.limit && rows.length >= action.limit) {
    help.push(
      `Showing the latest ${action.limit}; page further back with --before <the oldest messageId above>.`
    );
  }
  if (truncated > 0) {
    help.push(`${truncated} message(s) had content truncated to ${CONTENT_LIMIT} chars.`);
  }
  if (!wantAttachments) {
    const withAtt = messages.filter((m) => (m.attachments?.length ?? 0) > 0).length;
    if (withAtt > 0) {
      help.push(`${withAtt} message(s) have attachments; add --fields attachments to get their URLs.`);
    }
  }
  if (help.length) out.help = help;
  emit(out);
}

/**
 * Wrap low-level socket errnos like "can't connect to daemon" into an actionable structured
 * error (AXI §6). callDaemon (client.ts) returns only e.message for socket errors (e.g. "connect
 * ENOENT <path>"), dropping the code; so we detect the errno substring in the message — ENOENT
 * (socket missing) / ECONNREFUSED (nobody listening) — and tell the agent how to recover. Other
 * errors pass through as the bare message.
 */
function friendlyError(error: string, socket: string): { error: string; help?: string } {
  if (error.includes('ENOENT') || error.includes('ECONNREFUSED')) {
    return {
      error: `cannot reach the daemon (socket: ${socket}): ${error}`,
      help: 'Make sure `agent-anywhere start` is running, then retry.',
    };
  }
  return { error };
}
