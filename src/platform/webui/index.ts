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
import path from 'node:path';

import { configDir } from '../../config/load.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { MessageRef, SlashCommandSpec } from '../../types.js';
import type { PlatformAdapter } from '../adapter.js';
import { renderWebMarkdown } from '../web-markdown.js';
import { WebAuth } from './auth.js';
import { CHANNEL, TopicStore, WebRoom, type WebuiInstance } from './room.js';
import { createWebServer, type WebServer } from './server.js';

export { WebRoom, TopicStore, type Topic, type WebuiInstance } from './room.js';

/**
 * What this platform can do, declared honestly.
 *
 * Almost everything is true, which is unusual in this directory and is simply what a browser
 * is: it can redraw a message, show a button, strike one out, and stop a typing indicator on
 * command instead of waiting for it to expire.
 */
const CAPABILITIES: PlatformAdapter['capabilities'] = {
  editMessage: true,
  /**
   * Declared for the record; nothing in the daemon reads either. `addReaction` / `startTyping`
   * are called unconditionally and swallowed on failure, so the obligation these two flags
   * describe is really "these methods must be safe to call", which they are.
   */
  reaction: true,
  typing: true,
  reply: true,
  /**
   * Topics. Each is a lane on the one channel, so each is its own conversation with its own
   * agent session — the Telegram-forum shape, in a browser. `createThread` opens one, which
   * also means the agent can open one for itself.
   */
  thread: true,
  /**
   * And they can be named, which is the other half of that shape: the harness summarises what
   * a topic turned out to be about and the switcher shows it. This works only because a topic
   * IS a lane — `retitleLane` refuses any address without one, so the channel-per-topic
   * alternative would have left this permanently inert.
   */
  renameThread: true,
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
   * intercepts exactly as it does anywhere else. So there is no interaction to close out.
   */
  slashCommands: true,
  slashNeedsAck: false,
  canRegisterSlashAtRuntime: true,
  /**
   * Not a platform limit — a browser has none. It is a ceiling on how large one message may
   * grow before the writer seals it and starts another, and it exists because a streaming edit
   * re-renders the whole body: without a bound, one runaway reply becomes an unbounded DOM
   * node. 20k characters is far past any real answer, so nothing is ever split in practice.
   */
  maxMessageLength: 20_000,
  // maxEditsPerMessage is deliberately absent: nothing here refuses an edit after N of them.
};

/**
 * Build the adapter the daemon drives.
 *
 * `start()` binds the port — not this function. `createPlatformAdapters` runs in
 * `commands/start.ts` well before `Daemon.run()` registers the inbound handlers, so a server
 * listening from the factory would accept a message in that window and drop it into a null
 * handler with nothing logged.
 */
export function createWebuiAdapter(instance: WebuiInstance): PlatformAdapter {
  // Per instance rather than one shared file: two web UIs on two ports are two deployments,
  // and merging their topic lists would put one's rooms in the other's switcher.
  const topics = new TopicStore(path.join(configDir(), `webui-topics-${instance.id}.json`));
  // The page is never without a room to be in, including on a brand-new install.
  topics.current();
  const room = new WebRoom(instance, topics);
  const server = createWebServer(room, new WebAuth({ token: instance.token }), instance, {
    enabled: instance.terminal.enabled,
    // Beside the topic file above, and for the same reason: this is the directory both ends
    // of the terminal already share. The daemon's config lives here, so in a container it is
    // the bind mount, which is where ttyd can reach it without a second volume.
    socket: instance.terminal.socket ?? path.join(configDir(), `webui-term-${instance.id}.sock`),
  });
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
  /**
   * The topic an address names.
   *
   * Every outbound call has to say which room it is for, and the two ways of getting that
   * wrong both deserve an error rather than a guess: a channel that is not this instance's
   * (a `--channel` override on a reverse command) and a topic that no longer exists. Posting
   * either into "the only room there is" would be the wrong kind of helpful — there is now
   * more than one.
   */
  const topicOf = (address: ConversationAddress, op: string): string => {
    const where = `${address.channel}${address.thread ? `/${address.thread}` : ''}`;
    if (address.channel !== CHANNEL || !address.thread) {
      throw new Error(`[webui] ${op}: "${instance.id}" addresses topics as ${CHANNEL}/<topic id>, not ${where}`);
    }
    if (!room.topics.has(address.thread)) {
      throw new Error(`[webui] ${op}: no such topic ${where}`);
    }
    return address.thread;
  };
  const ref = (topic: string, id: string): MessageRef => ({
    address: { channel: CHANNEL, thread: topic },
    messageId: id,
  });

  return {
    async sendMessage(address, text) {
      const topic = topicOf(address, 'sendMessage');
      return ref(topic, room.post(topic, { own: false, html: renderWebMarkdown(text) }, text).id);
    },
    async editMessage(r, text) {
      room.revise(topicOf(r.address, 'editMessage'), r.messageId, text);
    },
    async deleteMessage(r) {
      room.remove(topicOf(r.address, 'deleteMessage'), r.messageId);
    },
    async sendFile(address, file) {
      const topic = topicOf(address, 'sendFile');
      const name = file.name ?? file.path.split('/').pop() ?? 'file';
      const url = room.publish(file.path, name);
      const caption = file.caption ?? '';
      return ref(topic, room.post(topic, { own: false, html: renderWebMarkdown(caption), file: { name, url } }, caption).id);
    },
    async replyMessage(r, text) {
      // A quote of the message being answered, which is all "native reply" can mean on a page
      // whose topics are flat: the reader sees what it is about without scrolling.
      const topic = topicOf(r.address, 'replyMessage');
      const quote = room.htmlOf(topic, r.messageId);
      return ref(topic, room.post(topic, { own: false, html: renderWebMarkdown(text), quote: { html: quote } }, text).id);
    },
    async sendButtons(address, text, buttons) {
      const topic = topicOf(address, 'sendButtons');
      return ref(topic, room.post(topic, { own: false, html: renderWebMarkdown(text), buttons }, text).id);
    },
    async editButtons(r, text, buttons) {
      room.revise(topicOf(r.address, 'editButtons'), r.messageId, text, buttons);
    },
    async addReaction(r, emoji) {
      room.react(topicOf(r.address, 'addReaction'), r.messageId, emoji, true);
    },
    async removeReaction(r, emoji) {
      room.react(topicOf(r.address, 'removeReaction'), r.messageId, emoji, false);
    },
    async startTyping(address) {
      room.setTyping(topicOf(address, 'startTyping'), true);
    },
    async stopTyping(address) {
      room.setTyping(topicOf(address, 'stopTyping'), false);
    },
    /**
     * Open a topic.
     *
     * Reached from the reverse command, so an agent can file a side errand into a room of its
     * own rather than into the middle of the conversation that asked for it. The daemon's own
     * `autoThread: 'perTurn'` never gets here — that path requires `kind: 'group'` and this
     * platform reports `'direct'`.
     */
    async createThread(_r, name) {
      const topic = room.createTopic(name);
      return { address: { channel: CHANNEL, thread: topic.id } };
    },
    /** Name a topic. The string is `formatLaneTitle`'s `[agent] subject`. */
    async renameThread(address, name) {
      room.renameTopic(topicOf(address, 'renameThread'), name);
    },
    /**
     * Identity, and it has to be: `maxMessageLength` counts the raw markdown the writer is
     * chunking, not the html this adapter renders it into. Measuring the html would make a
     * fenced code block read three to five times its real size and chop replies at a fraction
     * of the stated limit for no reason.
     */
    measureRendered(text) {
      return text.length;
    },
    async fetchHistory(address, opts) {
      return room.history(topicOf(address, 'fetchHistory'), opts);
    },
  };
}

function lifecycle(
  room: WebRoom,
  server: WebServer
): Pick<
  PlatformAdapter,
  'onMessage' | 'onButton' | 'onCommand' | 'useWorkdirLookup' | 'registerCommands' | 'start' | 'stop'
> {
  return {
    onMessage: (handler) => room.onMessage(handler),
    onButton: (handler) => room.onButton(handler),
    /**
     * The one platform that implements this, because it is the one with somewhere to put the
     * answer: the topic switcher's rows have a second line, and without this several topics
     * open on different projects are indistinguishable there.
     */
    useWorkdirLookup: (lookup) => room.useWorkdirLookup(lookup),
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
    stop: async () => {
      // Send whatever is being held before the sockets go, so a turn that ended just as the
      // daemon was asked to stop is not left with its last edit in a queue nobody will run.
      room.dispose();
      await server.stop();
    },
  };
}
