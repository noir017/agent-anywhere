import type { ConversationAddress } from '../core/conversation.js';
import type {
  ButtonInteraction,
  CommandInteraction,
  InboundMessage,
  MessageRef,
  SlashCommandSpec,
} from '../types.js';

/**
 * Platform capability interface. One layer above Satori so the core classes depend only on
 * capabilities, not concrete platforms; missing capabilities degrade gracefully in the
 * implementation (see capabilities).
 *
 * Every outbound method addresses a ConversationAddress ({channel, thread?}) rather than a
 * channel string, so a sub-lane (Telegram forum topic, Slack thread_ts) can never be lost in
 * transit or smuggled through as a composite string that some path forgets to decode.
 */
export interface PlatformAdapter {
  /** Platform INSTANCE id (the `platforms:` map key this adapter was built from). */
  readonly platform: string;
  /** Platform type ('discord'/'telegram'/…). */
  readonly platformType: string;
  readonly capabilities: PlatformCapabilities;

  /** First send; the returned MessageRef is later used for editMessage. */
  sendMessage(address: ConversationAddress, text: string): Promise<MessageRef>;

  /** In-place edit. When capabilities.editMessage is false the impl should throw, and the caller degrades to resending the whole segment. */
  editMessage(ref: MessageRef, text: string): Promise<void>;

  /**
   * Rendered length of `text` in the units capabilities.maxMessageLength counts (after the
   * platform's markdown rendering). Used by the StreamBuffer to chunk by real rendered size rather
   * than raw char count, since rendering can expand/shrink/re-unit the text (table→bullets, UTF-8
   * bytes, etc.). Defaults to text.length when the profile declares no measureRendered. */
  measureRendered(text: string): number;

  deleteMessage(ref: MessageRef): Promise<void>;

  sendFile(
    address: ConversationAddress,
    file: { path: string; name?: string; caption?: string }
  ): Promise<MessageRef>;

  /** Lifecycle reaction (👀 / ✅ / ❌). */
  addReaction(ref: MessageRef, emoji: string): Promise<void>;
  removeReaction(ref: MessageRef, emoji: string): Promise<void>;

  /** Typing indicator; some platforms have no stop, the impl may be a no-op. */
  startTyping(address: ConversationAddress): Promise<void>;
  stopTyping(address: ConversationAddress): Promise<void>;

  fetchHistory(
    address: ConversationAddress,
    opts: { limit?: number; before?: string }
  ): Promise<InboundMessage[]>;

  /** Register the inbound callback, attached when daemon starts. */
  onMessage(handler: (msg: InboundMessage) => void): void;

  // ---- Platform-layer interaction capabilities (vertical slice): true reply / thread / buttons / slash ----

  /** True reply: send a platform-native reply targeting ref (Discord message_reference). */
  replyMessage(ref: MessageRef, text: string): Promise<MessageRef>;

  /**
   * Create a thread from a message; returns the new thread's address, which later sends
   * target directly. `{channel}` where a thread is a channel (Discord); `{channel, thread}`
   * where it is a lane (Telegram topic, Slack thread_ts).
   */
  createThread(
    ref: MessageRef,
    name: string,
    opts?: { autoArchiveMinutes?: 60 | 1440 | 4320 | 10080 }
  ): Promise<{ address: ConversationAddress }>;

  /** Send a message with buttons (used by clarify). */
  sendButtons(
    address: ConversationAddress,
    text: string,
    buttons: Array<{
      id: string;
      label: string;
      style?: 'primary' | 'secondary' | 'success' | 'danger';
    }>
  ): Promise<MessageRef>;

  /**
   * Register slash commands (called once after the bot logs in).
   * With opts.guildId, guild-level registration (immediate); otherwise global (up to ~1h propagation).
   */
  registerCommands(cmds: SlashCommandSpec[], opts?: { guildId?: string }): Promise<void>;

  /** Receive button clicks. session → ButtonInteraction. Optional: safely ignored if daemon hasn't registered this round. */
  onButton(handler: (ev: ButtonInteraction) => void): void;

  /** Receive slash invocations. Optional: safely ignored if daemon hasn't registered this round. */
  onCommand(handler: (ev: CommandInteraction) => void): void;

  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface PlatformCapabilities {
  editMessage: boolean;
  reaction: boolean;
  typing: boolean;
  /** Per-message text limit; StreamBuffer chunks by it. */
  maxMessageLength: number;
  /** True reply (message_reference). */
  reply: boolean;
  /** Thread creation. */
  thread: boolean;
  /** Interactive buttons (send + receive). */
  buttons: boolean;
  /** Slash commands (register + receive). */
  slashCommands: boolean;
  /**
   * Max slash commands registerable at once (platform constraint). Excess is truncated by
   * priority, registering only the first N. Discord/Telegram are both 100; platforms without
   * registration leave 0. Meaningless when slashCommands=false.
   */
  maxSlashCommands?: number;
  /**
   * Whether a received slash command MUST be answered to close out the platform's interaction
   * (Discord: the adapter auto-emits a DEFERRED response and the UI shows "the application did not
   * respond" until a followup lands, so the daemon sends a short receipt). Telegram-style platforms
   * deliver slash as an ordinary message with nothing to close, where that receipt is pure noise —
   * the real reply is already coming. Absent/undefined treated as false.
   */
  slashNeedsAck?: boolean;
  /**
   * Whether the platform supports purely-runtime slash registration (no manual out-of-band step).
   * Absent/undefined treated as true, compatible with all existing profiles (Discord
   * bulkOverwrite, Telegram setMyCommands are both runtime). Slack explicitly false: its slash
   * commands must be registered out-of-band via the App config panel / app manifest, so
   * registerCommands is a runtime no-op — daemon skips the pointless registration call.
   * Orthogonal to slashCommands: slashCommands=true means "can receive slash", this field means
   * "can register at runtime".
   */
  canRegisterSlashAtRuntime?: boolean;
}
