import { z } from 'zod';
import type { InboundMessage } from '../types.js';

/**
 * IPC protocol for reverse commands (daemon <-> short-lived CLI process, unix
 * socket, newline-delimited JSON).
 *
 * Reverse commands (send-file / reply / react / fetch-messages …) don't connect to
 * the platform directly; they connect back to the daemon, which resolves them via
 * "turn token -> current session channel" and executes.
 *
 * Trust boundary: the peer is an arbitrary short-lived process (the agent subprocess)
 * and its JSON is untrusted. So before dispatch in server.ts we must validate
 * structure at runtime with this file's zod schema (parseIpcRequest), never
 * `as IpcRequest` blindly — a malformed/missing-field action would otherwise carry
 * undefined all the way down to the platform call layer.
 */

/** Optional channel: empty = current session. Empty string is illegal (treated as unset), hence min(1). */
const channelId = z.string().min(1).optional();

/**
 * How long an unanswered `ask` waits before giving up, when the caller names no `--timeout`.
 *
 * Lives in the protocol rather than in either side because BOTH sides need it and they need the
 * same number: the daemon arms its timer with it, and the CLI sizes its own socket deadline as this
 * plus a margin. They used to hold separate copies of `120_000`, which is the kind of duplication
 * that survives right up until one of them is tuned — and then the CLI abandons a question the
 * daemon is still waiting on, reporting "no selection" while the buttons are live in the chat.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 600_000;

/** Extra socket-deadline headroom the CLI adds on top of the ask timeout, so the daemon gives up first. */
export const ASK_CLIENT_TIMEOUT_MARGIN_MS = 10_000;

/**
 * Zod schema per action kind. Each arm maps one-to-one to the IpcAction union below;
 * a new action must be added in both, kept aligned at compile time via z.infer.
 * strict() rejects extra fields, narrowing the trusted input surface.
 */
const IpcActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('send-message'), channelId, text: z.string() }).strict(),
  z
    .object({ kind: z.literal('reply'), messageId: z.string().min(1), channelId, text: z.string() })
    .strict(),
  z
    .object({ kind: z.literal('edit-message'), messageId: z.string().min(1), channelId, text: z.string() })
    .strict(),
  z
    .object({
      kind: z.literal('send-file'),
      path: z.string().min(1),
      name: z.string().optional(),
      caption: z.string().optional(),
      channelId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('react'),
      messageId: z.string().min(1),
      emoji: z.string().min(1),
      channelId,
    })
    .strict(),
  z.object({ kind: z.literal('delete'), messageId: z.string().min(1), channelId }).strict(),
  z
    .object({
      kind: z.literal('fetch-messages'),
      channelId,
      limit: z.number().int().positive().optional(),
      before: z.string().min(1).optional(),
      // Presentation-only: which columns the CLI renders to stdout. The daemon returns full
      // messages regardless; field selection + truncation + TOON happen at the CLI boundary.
      fields: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('create-thread'),
      messageId: z.string().min(1),
      name: z.string().min(1),
      channelId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ask'),
      prompt: z.string(),
      options: z.array(z.string()),
      channelId,
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);

const IpcRequestSchema = z
  .object({
    token: z.string().min(1),
    action: IpcActionSchema,
  })
  .strict();

/**
 * Validate one IPC request from the peer. On success returns a type-safe IpcRequest;
 * on failure returns an error with the offending path (for the server to reply { ok:false }).
 */
export function parseIpcRequest(
  raw: unknown
): { ok: true; req: IpcRequest } | { ok: false; error: string } {
  const result = IpcRequestSchema.safeParse(raw);
  if (result.success) return { ok: true, req: result.data };
  const first = result.error.issues[0];
  const where = first?.path.join('.') || '(root)';
  return { ok: false, error: `malformed action: ${where} ${first?.message ?? ''}`.trim() };
}

export type IpcAction =
  | { kind: 'send-message'; channelId?: string; text: string }
  | { kind: 'reply'; messageId: string; channelId?: string; text: string }
  | { kind: 'edit-message'; messageId: string; channelId?: string; text: string }
  | { kind: 'send-file'; path: string; name?: string; caption?: string; channelId?: string }
  | { kind: 'react'; messageId: string; emoji: string; channelId?: string }
  | { kind: 'delete'; messageId: string; channelId?: string }
  | { kind: 'fetch-messages'; channelId?: string; limit?: number; before?: string; fields?: string[] }
  | { kind: 'create-thread'; messageId: string; name: string; channelId?: string }
  | { kind: 'ask'; prompt: string; options: string[]; channelId?: string; timeoutMs?: number };

// Compile-time alignment: the zod-inferred type must equal the hand-written union;
// if either side drifts, this type errors.
type _AssertActionAligned = [
  IpcAction extends z.infer<typeof IpcActionSchema> ? true : never,
  z.infer<typeof IpcActionSchema> extends IpcAction ? true : never,
];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertActionAligned: _AssertActionAligned = [true, true];

export interface IpcRequest {
  /** From AGENT_ANYWHERE_TURN_TOKEN; used to authenticate and locate the current session/channel. */
  token: string;
  action: IpcAction;
}

export type IpcResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

/** Response body for fetch-messages. */
export interface FetchMessagesResult {
  messages: InboundMessage[];
}

/** Response body for create-thread (the data field). */
export interface CreateThreadResult {
  threadId: string;
}

/** Response body for ask (blocking clarify): chosen = selected label; null = timeout/unselected. */
export interface AskResult {
  chosen: string | null;
}
