/**
 * The wire between the browser page and the web UI server.
 *
 * Split out from `server.ts` for the same reason `ipc/protocol.ts` is split out from
 * `ipc/server.ts`: this is a trust boundary, and a trust boundary is worth reading on its
 * own. Everything arriving from the page is untrusted — the page is served over a port that
 * config binds to `0.0.0.0` by default, and behind it sits an agent with full tool access.
 *
 * So every inbound body is validated by a `.strict()` zod schema and never cast. `.strict()`
 * matters as much as the field types: it rejects unknown keys outright, which keeps the
 * shape the server reasons about equal to the shape it declared, forever.
 *
 * The OUTBOUND direction has types but no schemas, and that asymmetry is deliberate: those
 * objects are constructed by this process, so validating them would only assert that the
 * code did what it says. There is nothing to distrust in that direction.
 */
import { z } from 'zod';

import type { ButtonSpec } from '../adapter.js';
import type { SlashCommandSpec } from '../../types.js';
import type { Topic } from './topics.js';

/**
 * Hard ceiling on one request body.
 *
 * Sized against `EXPERIENCE.attachments.maxDownloadBytes` (25 MiB — `config/schema.ts`)
 * plus base64's ~4/3 expansion and room for the JSON envelope. Deliberately duplicated as a
 * constant rather than read from the config: an adapter only ever receives its own
 * `platforms.<id>` entry, never the whole `Config` (see `platform/README.md`), and reaching
 * for the rest of it to avoid one documented number would break that seam for nothing.
 */
export const MAX_BODY_BYTES = 36 * 1024 * 1024;

/** Longest message the page may submit. Generous; the point is only to bound the buffer. */
const MAX_TEXT_CHARS = 200_000;

/** One file the page attached to a message, as base64 — see the adapter for why base64. */
const UploadSchema = z
  .object({
    name: z.string().min(1).max(255),
    /** Best-effort from the browser; `''` when it could not tell, which the ingest handles. */
    mime: z.string().max(255),
    /** base64, no data: prefix — the adapter builds the URL so the page cannot pick a scheme. */
    data: z.string().max(MAX_BODY_BYTES),
  })
  .strict();

export const LoginRequestSchema = z.object({ token: z.string().min(1).max(4096) }).strict();

/**
 * Which topic a request is about.
 *
 * Shaped, not free text: the id travels on as the lane half of the address `main/<id>`, which
 * `core/conversation.ts` splits on `/` and refuses to see twice. Rejecting the wrong shape here
 * keeps a malformed lane from ever reaching an address.
 */
const TopicId = z.string().regex(/^[0-9a-f]{8}$/, 'not a topic id');

export const SendRequestSchema = z
  .object({
    topic: TopicId,
    text: z.string().max(MAX_TEXT_CHARS),
    files: z.array(UploadSchema).max(10).optional(),
    /**
     * Client-generated, so a retry is safe.
     *
     * The point of the whole weak-network pass: a POST can time out after the server has
     * already accepted it, and a client that retries without this would send the message
     * twice. The daemon's own inbound dedup cannot help — it keys on the message id, and a
     * retry mints a fresh one.
     */
    nonce: z.string().min(1).max(64).optional(),
  })
  .strict();

export const CreateTopicRequestSchema = z.object({ title: z.string().max(200).optional() }).strict();

export const ClickRequestSchema = z
  .object({
    topic: TopicId,
    messageId: z.string().min(1).max(256),
    buttonId: z.string().min(1).max(512),
  })
  .strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type SendRequest = z.infer<typeof SendRequestSchema>;
export type ClickRequest = z.infer<typeof ClickRequestSchema>;
export type CreateTopicRequest = z.infer<typeof CreateTopicRequestSchema>;

/**
 * Validate one inbound body against a schema.
 *
 * Returns a result rather than throwing, and names the offending path, so the server answers
 * `400` with something a person debugging the page can act on — the same contract as
 * `parseIpcRequest`.
 */
export function parseBody<T>(
  schema: z.ZodType<T>,
  raw: unknown
): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  const where = first?.path.join('.') || '(root)';
  return { ok: false, error: `malformed request: ${where} ${first?.message ?? ''}`.trim() };
}

/**
 * What the server pushes down the SSE stream.
 *
 * `msg` is an UPSERT, not an append: a message the page already holds under that id is
 * replaced in place. One event kind rather than separate send/edit kinds, because the
 * daemon's streaming writer edits the same message dozens of times per turn and the page
 * would have to treat "edit an id I have never seen" as an append anyway — a reconnect
 * mid-turn produces exactly that. With upsert semantics there is no such case to get wrong.
 */
export type WebEvent =
  /**
   * Full replay of one topic, sent when a client connects without a resumable position.
   *
   * No longer sent on EVERY connect: a stream that reconnects with a `Last-Event-ID` the
   * backlog still covers is caught up with the events it missed instead. Re-sending the whole
   * conversation after every network blip was the single most expensive thing this protocol
   * did on a weak link.
   */
  | { t: 'sync'; topic: string; messages: WebMessage[]; commands: SlashCommandSpec[]; topics: Topic[] }
  | { t: 'msg'; msg: WebMessage }
  | { t: 'del'; id: string }
  | { t: 'react'; id: string; emoji: string; on: boolean }
  | { t: 'typing'; on: boolean }
  | { t: 'commands'; commands: SlashCommandSpec[] }
  /**
   * The topic list changed — one was created, renamed, or spoken in.
   *
   * Broadcast to every client regardless of which topic it is watching, because the switcher
   * has to stay current without subscribing to rooms nobody is reading. It is the only event
   * that crosses topics.
   */
  | { t: 'topics'; topics: Topic[] }
  /**
   * The daemon is going away; stop reconnecting.
   *
   * `EventSource` reconnects after ANY close, including a clean one, so without this a tab
   * left open through a restart hammers a dead port on a fixed retry interval — and, worse,
   * looks connected. The page answers it by closing the stream itself and saying so.
   */
  | { t: 'bye' };

/** One message as the page holds it. `html` is already rendered and escaped by web-markdown. */
export interface WebMessage {
  id: string;
  /** Whether the operator wrote it — the page's only styling distinction. */
  own: boolean;
  html: string;
  /** Epoch ms, for the dim timestamp. */
  at: number;
  /**
   * Buttons under the message. REQUIRED, and empty rather than absent when there are none.
   *
   * Because the daemon retires a menu by editing it with an EMPTY list — `retireAsk`,
   * `editModelMenu`, `editWorkdirMenu`, `editSettingsMenu` all call
   * `editButtons(ref, text, [])`. If this were optional and an empty list were sent as
   * "absent", the page's `if (msg.buttons)` would leave the old buttons live under an
   * already-answered question. That is the exact bug `editButtons` exists to fix on Slack and
   * Lark (see `daemon.ts` retireAsk), and it would be a shame to reintroduce it here.
   */
  buttons: ButtonSpec[];
  /** Lifecycle reactions currently on this message (👀 / ✅ / ❌). Empty, never absent, for the same reason. */
  reactions: string[];
  /** Set when the agent used a native reply; rendered as a quote above the body. */
  quote?: { html: string };
  /** Set when the message IS a file the agent sent. */
  file?: { name: string; url: string };
}
