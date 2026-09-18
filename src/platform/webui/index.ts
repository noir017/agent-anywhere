/**
 * The built-in web UI: a `PlatformAdapter` that is a browser page instead of a chat app.
 *
 * ── Why this does not go through the profile seam ─────────────────────────────
 * Every other platform here is assembled by `satori-core.ts` from a `PlatformProfile`, and
 * that assembly is built around a Satori `Bot`: it resolves one, calls `bot.sendMessage`,
 * normalises a `Session` into an `InboundMessage`, and delegates the platform's differences
 * to the profile. There is no bot here, no gateway and no upstream service — the daemon owns
 * both ends of this conversation. Forced through the seam, every profile method would be a
 * stub around state `room.ts` holds anyway, and `satori-core` would be carrying a `Context`
 * that installs nothing.
 *
 * So it implements `PlatformAdapter` directly, which is all the daemon ever sees. Same shape
 * as `daemon/agent-agy.ts` being a sibling runtime to `agent-acp.ts` rather than a pretend
 * ACP harness.
 *
 * ── What that costs, and where it is paid back ───────────────────────────────
 * Bypassing `satori-core` means bypassing what it does for EVERY platform, and the failure
 * mode of forgetting one is silence. Each is re-implemented with a comment naming it: the
 * listen allowlist (`chat.channels`) and the `[in]` log line in `room.ts`, connection logging
 * in `room.ts` and `server.ts`, `measureRendered` and the typed `MessageNotEditableError`
 * below.
 */
import type { ConversationAddress } from '../../core/conversation.js';
import type { MessageRef, SlashCommandSpec } from '../../types.js';
import type { PlatformAdapter } from '../adapter.js';
import { renderWebMarkdown } from '../web-markdown.js';
import { WebAuth } from './auth.js';
import { CHANNEL, WebRoom, type WebuiInstance } from './room.js';
import { createWebServer, type WebServer } from './server.js';

export { WebRoom, type WebuiInstance } from './room.js';

/**
 * What this platform can do, declared honestly.
 *
 * Almost everything is true, which is unusual in this directory and is simply what a browser
 * is: it can redraw a message, show a button, strike one out, and stop a typing indicator on
 * command instead of waiting for it to expire. The three falses are the interesting ones.
 */
const CAPABILITIES: PlatformAdapter['capabilities'] = {
  editMessage: true,
  /**
   * Declared for the record; nothing in the daemon reads it. `addReaction` / `startTyping`
   * are called unconditionally and swallowed on failure, so the obligation these two flags
   * describe is really "these methods must be safe to call", which they are.
   */
  reaction: true,
  typing: true,
  reply: true,
  /**
   * No threads. The page is one conversation, and inventing a lane inside it to satisfy a
   * capability would change how `conversationKey`, `formatAddress` and `chat.channels`
   * entries all spell this conversation, in exchange for nothing the page would show.
   */
  thread: false,
  /**
   * Which makes renaming moot: `retitleLane` refuses any address with no lane, so declaring
   * this true would only trade one accurate refusal for a less accurate one — and, until the
   * check was moved, would have spent a title-summarising model call per conversation first.
   */
  renameThread: false,
  buttons: true,
  editButtons: true,
  /**
   * The same 12 every other platform that declares one uses, and deliberately not a bigger
   * number a browser could obviously carry: `menu-page-size.test.ts` asserts that every
   * platform declaring a page size declares the SAME one, because which client someone reads
   * from should not change how many directories `/cd` offers them.
   */
  menuPageSize: 12,
  /**
   * Received, not registered in the platform's own UI — the same shape as Telegram, where a
   * slash command arrives as an ordinary message. `registerCommands` here only hands the page
   * the vocabulary for its autocomplete; invoking one sends plain text, which `route()`
   * intercepts exactly as it does anywhere else. So there is no interaction to close out,
   * hence no ack.
   */
  slashCommands: true,
  slashNeedsAck: false,
  canRegisterSlashAtRuntime: true,
  /**
   * Not a platform limit — a browser has none. It is a ceiling on how large one message may
   * grow before the writer seals it and starts another, and it exists because every streaming
   * edit re-sends the whole rendered body: without a bound, one runaway reply becomes an
   * unbounded DOM node redrawn several times a second. 20k characters is far past any real
   * answer, so in practice nothing is ever split.
   */
  maxMessageLength: 20_000,
  // maxEditsPerMessage is deliberately absent: nothing here refuses an edit after N of them.
};

/**
 * Build the adapter the daemon drives.
 *
 * `start()` binds the port — not the factory. `createPlatformAdapters` runs in
 * `commands/start.ts` well before `Daemon.run()` registers the inbound handlers, so a server
 * listening from the factory would accept a message in that window and drop it into a null
 * handler with nothing logged.
 */
export function createWebuiAdapter(instance: WebuiInstance): PlatformAdapter {
  const room = new WebRoom(instance);
  const server = createWebServer(room, new WebAuth({ token: instance.token }), instance);
  return { ...describe(instance), ...outbound(room, instance), ...lifecycle(room, server) };
}

function describe(instance: WebuiInstance): Pick<PlatformAdapter, 'platform' | 'platformType' | 'capabilities'> {
  return { platform: instance.id, platformType: 'webui', capabilities: CAPABILITIES };
}

type Outbound = Pick<
  PlatformAdapter,
  | 'sendMessage'
  | 'editMessage'
  | 'deleteMessage'
  | 'sendFile'
  | 'replyMessage'
  | 'sendButtons'
  | 'editButtons'
  | 'addReaction'
  | 'removeReaction'
  | 'startTyping'
  | 'stopTyping'
  | 'createThread'
  | 'renameThread'
  | 'measureRendered'
  | 'fetchHistory'
>;

function outbound(room: WebRoom, instance: WebuiInstance): Outbound {
  /** Every outbound call names an address; only one exists here, and silence would be wrong. */
  const here = (address: ConversationAddress, op: string): void => {
    if (address.channel === CHANNEL && address.thread === undefined) return;
    throw new Error(
      `[webui] ${op}: this instance serves one conversation (${CHANNEL}), not ${address.channel}${address.thread ? `/${address.thread}` : ''}`
    );
  };
  const ref = (id: string): MessageRef => ({ address: { channel: CHANNEL }, messageId: id });

  return {
    async sendMessage(address, text) {
      here(address, 'sendMessage');
      return ref(room.post({ own: false, html: renderWebMarkdown(text) }, text).id);
    },
    async editMessage(r, text) {
      room.revise(r.messageId, text);
    },
    async deleteMessage(r) {
      room.remove(r.messageId);
    },
    async sendFile(address, file) {
      here(address, 'sendFile');
      const name = file.name ?? file.path.split('/').pop() ?? 'file';
      const url = room.publish(file.path, name);
      const caption = file.caption ?? '';
      return ref(room.post({ own: false, html: renderWebMarkdown(caption), file: { name, url } }, caption).id);
    },
    async replyMessage(r, text) {
      // A quote of the message being answered, which is all "native reply" can mean on a page
      // that has no threads: the reader sees what it is about without scrolling.
      const quote = room.htmlOf(r.messageId);
      return ref(room.post({ own: false, html: renderWebMarkdown(text), quote: { html: quote } }, text).id);
    },
    async sendButtons(address, text, buttons) {
      here(address, 'sendButtons');
      return ref(room.post({ own: false, html: renderWebMarkdown(text), buttons }, text).id);
    },
    async editButtons(r, text, buttons) {
      room.revise(r.messageId, text, buttons);
    },
    async addReaction(r, emoji) {
      room.react(r.messageId, emoji, true);
    },
    async removeReaction(r, emoji) {
      room.react(r.messageId, emoji, false);
    },
    async startTyping(address) {
      here(address, 'startTyping');
      room.setTyping(true);
    },
    async stopTyping() {
      room.setTyping(false);
    },
    async createThread() {
      // Capability-gated by the daemon before it ever gets here; throwing rather than
      // returning a made-up address is the second line of defence satori-core has too.
      throw new Error(`[webui] "${instance.id}" has no threads: it serves one conversation`);
    },
    async renameThread() {
      throw new Error(`[webui] "${instance.id}" has no lane to rename`);
    },
    /**
     * Identity, and it has to be: `maxMessageLength` counts the raw markdown the writer is
     * chunking, not the html this adapter renders it into. Measuring the html would make a
     * fenced code block read three to five times its real size and chop replies at a third of
     * the stated limit for no reason.
     */
    measureRendered(text) {
      return text.length;
    },
    async fetchHistory(address, opts) {
      here(address, 'fetchHistory');
      return room.history(opts);
    },
  };
}

function lifecycle(
  room: WebRoom,
  server: WebServer
): Pick<PlatformAdapter, 'onMessage' | 'onButton' | 'onCommand' | 'registerCommands' | 'start' | 'stop'> {
  return {
    onMessage: (handler) => room.onMessage(handler),
    onButton: (handler) => room.onButton(handler),
    /**
     * Accepted and never called.
     *
     * A slash command reaches this platform as an ordinary message (see `slashCommands`
     * above), so there is no interaction event to normalise. The registration still has to be
     * accepted: the daemon wires all three handlers on every adapter before starting it, and
     * an adapter that refused one would fail `Daemon.run()`.
     */
    onCommand: () => {},
    async registerCommands(cmds: SlashCommandSpec[]) {
      room.setCommands(cmds);
    },
    start: () => server.start(),
    stop: () => server.stop(),
  };
}
