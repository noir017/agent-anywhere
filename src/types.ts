/**
 * Domain types shared across modules. Data shapes only; behavior lives in each module.
 */

import type { ConversationAddress, ConversationRef } from './core/conversation.js';

/**
 * A platform-agnostic message reference, usable for in-place edit / reaction / reply.
 *
 * Carries the full address rather than a channel string so that an operation on a
 * message inside a Telegram topic or a Slack thread still knows its lane. (Edits and
 * reactions happen not to need the lane on either API — but a ref that silently dropped
 * it was a trap for every future operation that does, and `reply` genuinely needs it.)
 */
export interface MessageRef {
  address: ConversationAddress;
  messageId: string;
}

/** Inbound message (already normalized by the Satori adapter core). */
export interface InboundMessage {
  /**
   * Where this message lives: channel, optional sub-lane (topic/thread), space, kind.
   * The single source of truth for routing, gating and every reply — see
   * core/conversation.ts for why this is a struct and not a composite string.
   */
  conversation: ConversationRef;
  /** Platform type ('discord'/'telegram'/…), for logs and type-specific behavior. Optional: absent on synthesized messages. */
  platformType?: string;
  messageId: string;
  /** Plain text content (platform markup stripped). */
  content: string;
  /** Target message id of a quote/reply (if any). */
  quoteId?: string;
  /** Original timestamp (ms); injected by the adapter so core logic never reads the system clock. */
  timestamp: number;
  /**
   * Platform URLs of attachments (image/file), fetchable by the agent on demand.
   * mime/size are best-effort from the adapter (undefined if unavailable); used to decide inbound download/injection.
   */
  attachments?: Array<{
    type: 'image' | 'file';
    url: string;
    name?: string;
    /** Content type (e.g. `text/plain`, `image/png`), filled if the adapter can obtain it. */
    mime?: string;
    /** Byte size, filled if the adapter can obtain it; used for inline/download threshold decisions. */
    size?: number;
  }>;

  // ---- Platform-normalized supplementary fields (all optional, backward compatible) ----
  // Filled by the adapter normalization layer for gating / identity labeling / reply backfill.

  /** Sender display name; labels who's speaking in multi-party context for the agent. */
  authorName?: string;
  /** Whether the sender is a bot; used for gating (allowBots: none/mentions/all filters on this). */
  authorIsBot?: boolean;
  /** Whether this message @-mentioned the bot itself; used for gating (guild channels need a mention by default). */
  mentionedSelf?: boolean;
  /** Body of the replied-to message; used for reply backfill (feeds context to the agent). */
  quotedContent?: string;
  /** Sender name of the replied-to message; used for reply backfill (labels the quoted identity). */
  quotedAuthor?: string;
}

/**
 * Button-click interaction (normalized form of a platform's native interaction).
 * The adapter receives a Discord MESSAGE_COMPONENT interaction, auto-ACKs, and normalizes to this shape.
 */
export interface ButtonInteraction {
  /**
   * Where the click happened — resolved by the SAME profile.resolveConversation as the
   * message path, so a button clicked inside a topic reaches the conversation that
   * posted it. When these disagreed, a blocking `ask` could never match its pending
   * request and sat until timeout.
   */
  conversation: ConversationRef;
  /** Id of the message the clicked button is on. */
  messageId: string;
  /** Button custom_id (the button id given at send time; no prefix added at this layer). */
  buttonId: string;
}

/**
 * Normalized form of a slash-command invocation interaction.
 * The adapter receives a Discord APPLICATION_COMMAND interaction, auto-ACKs, and normalizes to this shape.
 */
export interface CommandInteraction {
  /** Where the command was invoked (same resolution as the message path). */
  conversation: ConversationRef;
  /** Interaction message id (the Discord interaction's own id). */
  messageId: string;
  /** Command name, e.g. 'model'. */
  name: string;
  /** Command arguments (e.g. `{ name: 'gpt-x' }`). */
  options: Record<string, unknown>;
  /**
   * Reply closure: replies via followup using the session bound to this interaction.
   * It's a self-contained closure (rather than re-sending by address) because only the
   * original session carries the interaction token needed to hit followup; doing it without
   * the session via internal is possible but requires storing token+app_id ourselves.
   */
  reply: (text: string) => Promise<void>;
}

/**
 * An available command dynamically reported by the agent (ACP).
 * From session/update's `available_commands_update`; a platform-agnostic minimal shape.
 * The daemon registers it as each platform's native slash (see daemon registration logic) and,
 * when invoked, forwards `/<name> <input>` back to the agent as a prompt verbatim (the daemon doesn't interpret the command).
 */
export interface AgentCommand {
  /** Command name (no leading /, e.g. `create_plan`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** If the command takes input, the hint text shown to the user (ACP unstructured input.hint). */
  hint?: string;
}

/**
 * A question the AGENT asked the user, mid-turn, and is blocked on.
 *
 * From ACP `elicitation/create` (form mode) — the protocol's way for an agent to stop and ask
 * rather than guess. On the `claude` harness this is how the model's own `AskUserQuestion` tool
 * surfaces: the adapter keeps that tool disabled unless the client advertises
 * `clientCapabilities.elicitation.form`, so declaring the capability is what turns "the model
 * guesses, or asks in prose and ends its turn" into "the model asks and waits".
 *
 * Platform-agnostic on purpose: the ACP wire shape (a JSON Schema of `question_<n>` fields with
 * `oneOf` enums) is translated at the protocol boundary, so the daemon renders buttons from this
 * and never sees a schema. Multi-question forms become several rounds, asked in order.
 */
export interface AgentElicitation {
  /** The ask, shown above the first round's buttons (the question text for a single-question form). */
  message: string;
  /** One round per question, in the order the agent listed them. Never empty. */
  questions: ElicitQuestion[];
}

/** One round of an elicitation: what to ask, and the options to offer as buttons. */
export interface ElicitQuestion {
  /** Wire field key the answer must be returned under (`question_<n>`); opaque to the renderer. */
  key: string;
  /** Prompt for this round. For a single-question form this repeats AgentElicitation.message. */
  prompt: string;
  /** Choosable options. Never empty. */
  options: ElicitOption[];
  /**
   * Whether the wire field takes an array (ACP multi-select). Buttons are one tap, so the daemon
   * still collects exactly one option and returns it wrapped — the alternative (a stateful
   * multi-select UI on eight IM platforms) buys little over the model re-asking.
   */
  multi: boolean;
}

/**
 * One choosable option. `label` and `value` are separate because ACP's `EnumOption` separates
 * them: `title` is display text and `const` is what the answer must carry. They happen to be
 * identical for claude's AskUserQuestion bridge (both are the option label), but an MCP server's
 * own elicitation is free to make them differ, and returning the display text as the answer would
 * silently give that server a value it never offered.
 *
 * `description` is the model's own reasoning for this option, and it is the whole point of asking
 * with buttons rather than in prose — a real payload reads "you already run pgvector here, so
 * reusing it costs nothing". Buttons cannot carry it, so the renderer puts it in the message body
 * above them; dropping it would leave the user picking between bare nouns.
 */
export interface ElicitOption {
  label: string;
  value: string;
  description?: string;
}

/**
 * The user's verdict on an elicitation, in ACP's own vocabulary.
 *
 * `cancel` is the answer for "nobody pressed anything": it tells the agent the question was
 * abandoned, which the harness reports back to the model as an unanswered tool call — strictly
 * better than fabricating a choice it will then act on.
 */
export type ElicitAnswer =
  | { action: 'accept'; content: Record<string, string | string[]> }
  | { action: 'decline' }
  | { action: 'cancel' };

/**
 * Slash-command registration spec (platform-agnostic minimal description).
 * The adapter maps it to each platform's native command structure (Discord -> Universal.Command).
 */
export interface SlashCommandSpec {
  /** Command name (1-32 chars, lowercase). */
  name: string;
  /** Command description. */
  description: string;
  /** Command arguments (optional). */
  options?: Array<{
    name: string;
    description: string;
    /** Argument type; defaults to string. */
    type?: 'string' | 'boolean' | 'number' | 'integer';
    /** Whether required; defaults to false. */
    required?: boolean;
  }>;
}

/**
 * Identifier of a conversation: which conversation an inbound message belongs to.
 * Computed by core/conversation.ts conversationKey(scope, ref) per scope
 * (per_thread/per_channel/per_user/shared).
 *
 * Deliberately NOT agent-qualified: the agent answering a conversation is a mutable
 * property of it, not part of its identity (see core/conversation.ts).
 */
export type ConversationId = string;

/**
 * Tool-bubble render mode (domain concept shared by the core renderer and config schema).
 * off: no render / all: render every tool / new: dedupe consecutive same-name / verbose: include full args.
 */
export type ToolMode = 'off' | 'all' | 'new' | 'verbose';

/** Tool-call (start) event (from the claude agent sdk stream). */
export interface ToolEvent {
  name: string;
  /** Input summary for preview (the renderer truncates). */
  inputPreview: string;
  /** Full args shown in verbose mode. */
  input?: unknown;
  /**
   * Monotonically increasing index, used to relate the corresponding finish event back to this start.
   * The accumulate grouping mode uses it to locate and edit the same bubble (in-place progress refresh).
   */
  index?: number;
}

/**
 * Tool-finish event: emitted when a tool call ends, paired with the same-index ToolEvent (start).
 * The renderer uses it to update the matching bubble to a "done/duration" state in accumulate mode.
 */
export interface ToolFinishEvent {
  /** Tool name (same as start). */
  name: string;
  /** Index relating back to start; corresponds to ToolEvent.index. */
  index?: number;
  /** Success (true = completed normally, false = errored). */
  ok: boolean;
  /** Duration of this tool call (ms). */
  durationMs: number;
}

/**
 * A session's model selector, as the harness exposes it (ACP session config option `model`).
 *
 * Read off the live session rather than from config: `agents[].model` is an intent a harness may
 * ignore (opencode does — it reported its own default until the daemon set the option explicitly),
 * and a harness that pins its model elsewhere (claude, via ANTHROPIC_MODEL) offers no selector at
 * all, which is a different answer from "the list is empty".
 */
export interface ModelSelector {
  /** The model serving this session right now. */
  current?: string;
  /** Selectable ids with the display names the harness gave them. May be empty. */
  options: Array<{ value: string; name: string }>;
}
