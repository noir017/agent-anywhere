/**
 * The web UI's conversations: topics, their messages, their subscribers, and both directions
 * of traffic.
 *
 * ── Topics ───────────────────────────────────────────────────────────────────
 * Each topic is a LANE on the one channel — `{ channel: 'main', thread: '<topic id>' }` — so
 * each is its own conversation with its own agent session and its own harness-generated name.
 * See `index.ts` for why a lane rather than a channel of its own, and why the `kind` stays
 * `'direct'` even though a lane is set.
 *
 * Messages live in a bounded in-memory ring PER TOPIC, replayed to a browser that connects
 * without a resumable position. A daemon restart therefore empties the page while the agent
 * keeps its context, which is why the topic LIST is persisted (see `topics.ts`) even though
 * the transcript is not: without the ids, those contexts would still be running and no longer
 * reachable.
 *
 * ── Built for a weak link ────────────────────────────────────────────────────
 * Three things here exist because this is expected to be read over a bad connection, and each
 * would be simpler without that constraint:
 *
 * 1. **Edits are held, not broadcast.** Every streaming flush re-renders the whole message, so
 *    naively announcing each one sends the same growing body over and over. An edit is queued
 *    and emitted once the message stops changing (or after a cap, so a long reply still shows
 *    progress). See `enqueue`.
 * 2. **Every event carries a sequence number**, so a stream that drops and reconnects is
 *    caught up with what it missed instead of being re-sent the whole conversation.
 * 3. **The stream is per topic.** A client reading one topic is not billed for traffic in
 *    another. Only the topic LIST crosses rooms.
 *
 * Deliberately free of HTTP: everything here is exercisable without opening a port, which is
 * what `room.test.ts` drives.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import {
  addressListed,
  addressOf,
  describeConversation,
  type ConversationRef,
} from '../../core/conversation.js';
import { MessageNotEditableError } from '../../core/outbound-errors.js';
import type { ButtonInteraction, InboundMessage, SlashCommandSpec } from '../../types.js';
import type { ButtonSpec } from '../adapter.js';
import type { WebuiPlatformConfig } from '../config-schemas.js';
import { escapeHtml, renderWebMarkdown } from '../web-markdown.js';
import type { ClickRequest, SendRequest, WebEvent, WebMessage } from './protocol.js';
import { TopicStore, type Topic } from './topics.js';

/** A `platforms.<id>` entry of type `webui`, plus its map key. */
export type WebuiInstance = WebuiPlatformConfig & { id: string };

/**
 * The one channel, and the one operator.
 *
 * Constants rather than config: they are not addresses of anything real, they are the names
 * this platform answers to. `access.allowFrom` matches `<instance id>:owner`, and a reverse
 * command reaches one topic as `--channel main/<topic id>`.
 */
export const CHANNEL = 'main';
export const OWNER = 'owner';

/** How many messages a topic remembers across a page reload. Memory in a daemon that runs for weeks. */
const MAX_MESSAGES = 500;

/** How many emitted events a topic keeps so a reconnect can be caught up rather than re-synced. */
const MAX_BACKLOG = 300;

/** How many of the agent's sent files stay downloadable, across all topics. */
const MAX_DOWNLOADS = 200;

/**
 * How long a topic's working directory is reused before it is looked up again.
 *
 * The lookup is not free — it crosses into the daemon, which resolves a conversation key, finds
 * the bound agent and stats the recorded directory — and `topicList()` is rebuilt on every
 * message posted into any topic, so a streamed answer would ask the same question a hundred
 * times a turn. The answer only changes when someone runs `/cd`, so a few seconds of staleness
 * costs a label that is briefly out of date on a sidebar and saves the rest.
 *
 * Exported only so `room.test.ts` can assert the bound by name instead of restating the number.
 */
export const DIR_TTL_MS = 5000;

/**
 * How long a message must stop changing before its edit is announced.
 *
 * A debounce, not a throttle, and that is the whole point: a reply being streamed is rewritten
 * every flush, and announcing each one re-sends the entire rendered body.
 *
 * ⚠️ The number is chosen RELATIVE to another module's constant and cannot be read on its own.
 * `EXPERIENCE.stream.flushIntervalMs` is 1200ms (`config/schema.ts`), so an edit arrives at
 * most every ~1.2s while a reply streams. Anything BELOW that and the debounce expires between
 * every pair of edits — each one is announced separately, a fixed delay is added to all of
 * them, and nothing is saved at all. Above it, a stream in progress keeps re-arming the timer
 * and is emitted on the cap below instead; the settle then only fires once the stream stops.
 * If that 1200 ever changes, this has to move with it.
 *
 * The trailing cost is smaller than it looks: a turn ends with a lifecycle reaction, and a
 * reaction flushes the queue (see `flush`), so the final text of a reply goes out with the ✅
 * rather than waiting this out.
 */
const SETTLE_MS = 1_500;

/**
 * …but never hold one longer than this.
 *
 * Without a cap, a reply that streams continuously for a minute would show nothing for a
 * minute, which reads as a hung daemon — the exact failure the buffering is supposed to avoid
 * on a slow link, arrived at from the other side.
 */
const MAX_HOLD_MS = 8_000;

/** How many recent send-nonces are remembered, so a retry on a flaky link cannot double-send. */
const MAX_NONCES = 64;

/** One message as a topic holds it: what the page renders, plus what produced it. */
interface Stored {
  msg: WebMessage;
  /** The markdown the html was rendered from — what `fetch-messages` must hand back. */
  text: string;
}

/** Where an event goes. `id` is the SSE event id a reconnect may resume from. */
export type Sink = (id: string, ev: WebEvent) => void;

interface Client {
  topic: string;
  send: Sink;
}

/** One topic's live state. Created on demand for any topic the store knows. */
interface Room {
  stored: Map<string, Stored>;
  typing: boolean;
  seq: number;
  backlog: Array<{ seq: number; ev: WebEvent }>;
  /** Message ids whose edits are waiting to go out, in the order they were first held. */
  queue: string[];
  timer: NodeJS.Timeout | null;
  /** When the current hold must end regardless of further edits; 0 when nothing is held. */
  holdUntil: number;
  msgCount: number;
}

export class WebRoom {
  private seqId = 0;
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Set<Client>();
  private readonly downloads = new Map<string, { path: string; name: string }>();
  private readonly nonces = new Set<string>();
  private commands: SlashCommandSpec[] = [];

  private onMsg: ((m: InboundMessage) => void) | null = null;
  private onBtn: ((ev: ButtonInteraction) => void) | null = null;
  /** Injected by the daemon; absent in a deployment (or a test) that never offered one. */
  private workdir: ((ref: ConversationRef) => string | undefined) | null = null;
  private readonly dirCache = new Map<string, { at: number; dir?: Topic['dir'] }>();

  constructor(
    private readonly instance: WebuiInstance,
    readonly topics: TopicStore
  ) {}

  // ── Topics ─────────────────────────────────────────────────────────────────

  /** Create a topic and tell every client about it. Throws past the store's cap. */
  createTopic(title = ''): Topic {
    const topic = this.topics.create(title);
    this.announceTopics();
    return topic;
  }

  /** Name a topic — what `renameThread` lands on, i.e. what the harness decided it is about. */
  renameTopic(id: string, title: string): boolean {
    if (!this.topics.rename(id, title)) return false;
    this.announceTopics();
    return true;
  }

  /** Delete a topic, disposing its room state and announcing the new list. */
  deleteTopic(id: string): boolean {
    const room = this.rooms.get(id);
    if (room) {
      if (room.timer) clearTimeout(room.timer);
      this.rooms.delete(id);
    }
    this.dirCache.delete(id);
    if (!this.topics.delete(id)) return false;
    this.announceTopics();
    return true;
  }

  /**
   * Accept the daemon's way of asking where a topic's conversation is working.
   *
   * Pull, not push — see `PlatformAdapter.useWorkdirLookup` for why the daemon does not simply
   * tell us. Everything cached under a previous lookup is dropped, since the new one is by
   * definition a different daemon's answer.
   */
  useWorkdirLookup(lookup: (ref: ConversationRef) => string | undefined): void {
    this.workdir = lookup;
    this.dirCache.clear();
  }

  /**
   * The directory label for one topic, memoised for `DIR_TTL_MS`.
   *
   * Swallows a failing lookup rather than letting it out: this runs inside the path that
   * announces a topic list, which runs inside the path that posts a message, and a sidebar
   * label is not worth losing an answer over.
   */
  private dirOf(topicId: string): Topic['dir'] {
    if (!this.workdir) return undefined;
    const now = Date.now();
    const hit = this.dirCache.get(topicId);
    if (hit && now - hit.at < DIR_TTL_MS) return hit.dir;
    let full: string | undefined;
    try {
      full = this.workdir(this.conversation(topicId));
    } catch (e) {
      console.warn('[webui] could not resolve a topic working directory:', e instanceof Error ? e.message : e);
    }
    // basename('/') is '', and a directory with no last segment has no short name to show — the
    // full path is then both the label and the tooltip, which is honest and still fits.
    const dir = full ? { name: basename(full) || full, path: full } : undefined;
    this.dirCache.set(topicId, { at: now, dir });
    return dir;
  }

  topicList(): Topic[] {
    return this.topics.list().map((t) => {
      const room = this.rooms.get(t.id);
      const dir = this.dirOf(t.id);
      return {
        ...t,
        running: Boolean(room?.typing),
        msgCount: room?.msgCount ?? 0,
        ...(dir ? { dir } : {}),
      };
    });
  }

  private announceTopics(): void {
    const topics = this.topicList();
    // The one event that crosses rooms: the switcher has to stay current without every client
    // subscribing to topics nobody is reading.
    for (const client of this.clients) this.deliver(client, { t: 'topics', topics });
  }

  // ── Subscribers ────────────────────────────────────────────────────────────

  /**
   * Attach a client to one topic, resuming from `lastEventId` when it can.
   *
   * The resume is the single biggest saving on a bad connection. `EventSource` reconnects by
   * itself after any blip and sends back the last id it saw; if the backlog still reaches that
   * far, the client is handed only what it missed. Re-sending the whole conversation every
   * time the radio hiccuped was what this protocol did before, and on a long topic that is
   * hundreds of kilobytes per hiccup.
   *
   * The id carries its topic (`<topic>.<seq>`), so a tab that switched topics cannot resume
   * against the wrong room's numbering — it falls back to a full sync, which is correct.
   */
  subscribe(topicId: string, send: Sink, lastEventId?: string): () => void {
    const client: Client = { topic: topicId, send };
    this.clients.add(client);
    const room = this.roomOf(topicId);
    const missed = this.replayFrom(room, topicId, lastEventId);
    const ok = missed
      ? missed.every((entry) => this.deliver(client, entry.ev, entry.seq))
      : this.deliver(client, this.syncEvent(topicId, room));
    if (ok) {
      console.log(
        `[webui] client attached to ${topicId}${missed ? ` (resumed, ${missed.length} missed)` : ' (full sync)'}; ${this.clients.size} watching`
      );
    }
    return () => {
      if (this.clients.delete(client)) console.log(`[webui] client left (${this.clients.size} watching)`);
    };
  }

  /** Events after `lastEventId`, or undefined when a full sync is the only honest answer. */
  private replayFrom(
    room: Room,
    topicId: string,
    lastEventId: string | undefined
  ): Array<{ seq: number; ev: WebEvent }> | undefined {
    if (!lastEventId) return undefined;
    const dot = lastEventId.lastIndexOf('.');
    if (dot < 0 || lastEventId.slice(0, dot) !== topicId) return undefined;
    const from = Number(lastEventId.slice(dot + 1));
    if (!Number.isFinite(from)) return undefined;
    const oldest = room.backlog[0];
    // Nothing kept that far back: the gap cannot be filled, so say so by re-syncing rather
    // than silently handing over a transcript with a hole in it.
    if (room.backlog.length > 0 && oldest && oldest.seq > from + 1) return undefined;
    return room.backlog.filter((entry) => entry.seq > from);
  }

  private syncEvent(topicId: string, room: Room): WebEvent {
    return {
      t: 'sync',
      topic: topicId,
      messages: [...room.stored.values()].map((s) => s.msg),
      commands: this.commands,
      topics: this.topicList(),
    };
  }

  get watchers(): number {
    return this.clients.size;
  }

  // ── Emitting ───────────────────────────────────────────────────────────────

  /**
   * Announce an event in a topic: record it in that topic's backlog, then fan it out.
   *
   * Everything a client ever receives except the topic list goes through here, so the
   * sequence numbering and the backlog cannot disagree with what was actually sent.
   */
  private emit(topicId: string, ev: WebEvent): void {
    const room = this.roomOf(topicId);
    room.seq += 1;
    room.backlog.push({ seq: room.seq, ev });
    if (room.backlog.length > MAX_BACKLOG) room.backlog.shift();
    for (const client of this.clients) {
      if (client.topic === topicId) this.deliver(client, ev, room.seq);
    }
  }

  /**
   * Write to one client, dropping it if it fails. Returns whether it is still attached.
   *
   * The only place an event reaches a client, so one wedged socket can never take a turn down
   * with it — a failure here is a browser that went away, not a problem with the message.
   */
  private deliver(client: Client, ev: WebEvent, seq?: number): boolean {
    try {
      client.send(seq === undefined ? '' : `${client.topic}.${seq}`, ev);
      return true;
    } catch (e) {
      console.warn('[webui] dropping a client that failed to receive:', e instanceof Error ? e.message : e);
      this.clients.delete(client);
      return false;
    }
  }

  // ── The hold queue ─────────────────────────────────────────────────────────

  /**
   * Hold a message's edit instead of announcing it.
   *
   * Coalesced by message id, and the queue stores the ID rather than a snapshot on purpose:
   * the payload is materialised at flush time, so a held message is always sent at its newest
   * state and can never disagree with what a concurrent `sync` just handed someone.
   */
  private enqueue(room: Room, topicId: string, id: string): void {
    if (!room.queue.includes(id)) room.queue.push(id);
    const now = Date.now();
    if (room.holdUntil === 0) room.holdUntil = now + MAX_HOLD_MS;
    if (room.timer) clearTimeout(room.timer);
    const wait = Math.max(0, Math.min(SETTLE_MS, room.holdUntil - now));
    room.timer = setTimeout(() => this.flush(room, topicId), wait);
    // Never the reason the process stays alive: `daemon.stop()` is called directly by several
    // tests, and a live timer there hangs the runner.
    room.timer.unref();
  }

  /**
   * Send everything being held, oldest first.
   *
   * Called before any NON-edit event as well as on the timer, and that ordering rule is what
   * keeps the page readable: a tool bubble is a new message (which flushes), its progress is
   * an edit (which is held), and the text of the next segment is another new message (which
   * flushes again) — so the bubble's final state always arrives above the text that followed
   * it. Getting that backwards is the bug `daemon/render-order.test.ts` exists for, one layer
   * further up.
   */
  private flush(room: Room, topicId: string): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    room.holdUntil = 0;
    const queued = room.queue.splice(0);
    for (const id of queued) {
      const rec = room.stored.get(id);
      if (rec) this.emit(topicId, { t: 'msg', msg: rec.msg });
    }
  }

  // ── Outbound (daemon → page) ───────────────────────────────────────────────

  /**
   * Add a message to a topic.
   *
   * Resolves whether or not anybody is connected, deliberately: the ring is the conversation
   * and the clients are a fan-out of it. An adapter that failed when no browser was open would
   * fail every turn started before someone opened the page — and the daemon would report that
   * failure by posting into the same empty room.
   */
  post(
    topicId: string,
    part: Omit<WebMessage, 'id' | 'at' | 'buttons' | 'reactions'> & { buttons?: ButtonSpec[] },
    text: string
  ): WebMessage {
    const room = this.roomOf(topicId);
    this.flush(room, topicId);
    const msg: WebMessage = {
      ...part,
      // Ids are global and never reused, not per topic: the outbound pacer coalesces edits
      // into `edit:<channel>:<messageId>`, and every topic shares the one channel, so an id
      // restarting per topic would let one topic's edits supersede another's.
      id: this.nextId(),
      at: Date.now(),
      buttons: part.buttons ?? [],
      reactions: [],
    };
    if (room.stored.size >= MAX_MESSAGES) {
      const oldest = room.stored.keys().next().value;
      if (oldest !== undefined) room.stored.delete(oldest);
    }
    room.stored.set(msg.id, { msg, text });
    room.msgCount += 1;
    this.emit(topicId, { t: 'msg', msg });
    this.topics.touch(topicId, msg.at);
    this.announceTopics();
    return msg;
  }

  /**
   * Replace a message's body and buttons in place.
   *
   * A text-only edit is HELD (see `enqueue`) — that is streaming progress, and coalescing it is
   * the whole point of the queue. An edit that carries BUTTONS is sent at once instead, because
   * every one of them is the acknowledgement of a tap: a menu page turn, a question being retired,
   * a multi-select tick. The page disables a button the moment it is clicked and re-enables it
   * only when the message repaints, so holding that repaint for the settle window leaves the
   * control the user just pressed greyed out and unpressable for a second and a half — which on a
   * multi-select (tap, untap, tap again) is not a delay but a broken control.
   */
  revise(topicId: string, id: string, text: string, buttons?: ButtonSpec[]): void {
    const room = this.roomOf(topicId);
    const rec = this.mustFind(room, id, 'edit');
    rec.text = text;
    rec.msg = { ...rec.msg, html: renderWebMarkdown(text), ...(buttons ? { buttons } : {}) };
    room.stored.set(id, rec);
    this.enqueue(room, topicId, id);
    if (buttons) this.flush(room, topicId);
  }

  /** Remove a message. Removing one that is already gone is success, not an error. */
  remove(topicId: string, id: string): void {
    const room = this.roomOf(topicId);
    this.flush(room, topicId);
    if (!room.stored.delete(id)) return;
    this.emit(topicId, { t: 'del', id });
  }

  /**
   * Add or remove a lifecycle reaction (👀 / ✅ / ❌).
   *
   * Silent on an unknown id rather than throwing, unlike an edit: reactions are best-effort
   * decoration that every caller already wraps in a catch, and one that cannot land costs the
   * user nothing — whereas an edit that cannot land costs them the text.
   */
  react(topicId: string, id: string, emoji: string, on: boolean): void {
    const room = this.roomOf(topicId);
    const rec = room.stored.get(id);
    if (!rec) return;
    this.flush(room, topicId);
    const kept = rec.msg.reactions.filter((e) => e !== emoji);
    rec.msg = { ...rec.msg, reactions: on ? [...kept, emoji] : kept };
    room.stored.set(id, rec);
    this.emit(topicId, { t: 'react', id, emoji, on });
  }

  setTyping(topicId: string, on: boolean): void {
    const room = this.roomOf(topicId);
    if (room.typing === on) return;
    room.typing = on;
    this.flush(room, topicId);
    this.emit(topicId, { t: 'typing', on });
    this.announceTopics();
  }

  /** The registered slash vocabulary, for the page's autocomplete. Not per topic. */
  setCommands(commands: SlashCommandSpec[]): void {
    this.commands = commands;
    for (const client of this.clients) this.deliver(client, { t: 'commands', commands });
  }

  /** The rendered body of a message, for quoting it. Empty when it is no longer held. */
  htmlOf(topicId: string, id: string): string {
    return this.roomOf(topicId).stored.get(id)?.msg.html ?? '';
  }

  /**
   * Register a file the agent sent, and return the page-relative URL that serves it.
   *
   * The path never reaches the browser and the browser never names one: it gets an opaque
   * token this map alone can resolve. Relative (`f/<token>`, no leading slash) so the page
   * works unchanged when a reverse proxy mounts it under a sub-path.
   */
  publish(path: string, name: string): string {
    if (this.downloads.size >= MAX_DOWNLOADS) {
      const oldest = this.downloads.keys().next().value;
      if (oldest !== undefined) this.downloads.delete(oldest);
    }
    const token = randomUUID().replace(/-/g, '');
    this.downloads.set(token, { path, name });
    return `f/${token}`;
  }

  resolveDownload(token: string): { path: string; name: string } | undefined {
    return this.downloads.get(token);
  }

  /** Send everything being held and stop every timer. Called on shutdown. */
  dispose(): void {
    for (const [topicId, room] of this.rooms) this.flush(room, topicId);
  }

  // ── Inbound (page → daemon) ────────────────────────────────────────────────

  onMessage(handler: (m: InboundMessage) => void): void {
    this.onMsg = handler;
  }

  onButton(handler: (ev: ButtonInteraction) => void): void {
    this.onBtn = handler;
  }

  /**
   * The operator sent something. Echo it into the topic, then hand it to the daemon.
   *
   * Idempotent on `nonce`, which is what lets the page retry a request that timed out on a bad
   * link. Without it the honest choices are "retry and risk sending twice" or "do not retry",
   * and both are worse than remembering 64 strings.
   */
  submit(req: SendRequest): 'accepted' | 'duplicate' | 'unknown-topic' {
    if (!this.topics.has(req.topic)) return 'unknown-topic';
    if (req.nonce !== undefined) {
      if (this.nonces.has(req.nonce)) return 'duplicate';
      if (this.nonces.size >= MAX_NONCES) {
        const oldest = this.nonces.values().next().value;
        if (oldest !== undefined) this.nonces.delete(oldest);
      }
      this.nonces.add(req.nonce);
    }
    const attachments = (req.files ?? []).map(toAttachment);
    const text = req.text.trim();
    // The inbound gate drops an empty message anyway; stopping here keeps an accidental Enter
    // from appearing in the transcript as a blank bubble the agent never saw.
    if (!text && attachments.length === 0) return 'accepted';
    if (this.topics.seed(req.topic, req.text)) this.announceTopics();
    const msg = this.post(req.topic, { own: true, html: renderBody(req.text, attachments) }, req.text);
    const inbound: InboundMessage = {
      conversation: this.conversation(req.topic),
      platformType: 'webui',
      messageId: msg.id,
      content: req.text,
      timestamp: msg.at,
      ...(attachments.length > 0 ? { attachments } : {}),
      authorIsBot: false,
    };
    // The listen allowlist, which `satori-core` applies for every other platform and this
    // adapter therefore has to apply for itself. `main` covers every topic, `main/<id>` names
    // one — the matching `addressSelects` already implements.
    if (!this.channelAllowed(inbound.conversation)) {
      console.log(`[webui] "${this.instance.id}": dropped a message — chat.channels does not list ${CHANNEL}/${req.topic}`);
      return 'accepted';
    }
    console.log(`[in] ${describeConversation(inbound.conversation)} @${OWNER}: ${text.slice(0, 50).replace(/\n/g, ' ')}`);
    this.onMsg?.(inbound);
    return 'accepted';
  }

  /**
   * A button was clicked.
   *
   * The message id is checked against the topic's ring before it is forwarded: it arrives from
   * the page, and the daemon's click handlers go on to EDIT the message it names, so an id
   * nothing here holds is a stale tab or a hand-made request and neither should reach a writer.
   */
  click(req: ClickRequest): boolean {
    if (!this.topics.has(req.topic) || !this.roomOf(req.topic).stored.has(req.messageId)) return false;
    this.onBtn?.({
      conversation: this.conversation(req.topic),
      messageId: req.messageId,
      buttonId: req.buttonId,
    });
    return true;
  }

  /** Replay for `agent-anywhere fetch-messages`, oldest first, in the shape history has. */
  history(topicId: string, opts: { limit?: number; before?: string }): InboundMessage[] {
    const all = [...this.roomOf(topicId).stored.values()];
    const cut = opts.before ? all.findIndex((s) => s.msg.id === opts.before) : -1;
    const upto = cut >= 0 ? all.slice(0, cut) : all;
    const limited = opts.limit !== undefined ? upto.slice(-opts.limit) : upto;
    return limited.map((s) => ({
      conversation: this.conversation(topicId),
      platformType: 'webui',
      messageId: s.msg.id,
      content: s.text,
      timestamp: s.msg.at,
      authorIsBot: !s.msg.own,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private roomOf(topicId: string): Room {
    let room = this.rooms.get(topicId);
    if (!room) {
      room = { stored: new Map(), typing: false, seq: 0, backlog: [], queue: [], timer: null, holdUntil: 0, msgCount: 0 };
      this.rooms.set(topicId, room);
    }
    return room;
  }

  private nextId(): string {
    this.seqId += 1;
    return `w${this.seqId}`;
  }

  private mustFind(room: Room, id: string, op: string): Stored {
    const rec = room.stored.get(id);
    if (rec) return rec;
    // MessageNotEditableError, specifically: it means "this message will never accept another
    // edit", which is exactly true of one the ring has evicted. StreamBuffer answers it by
    // sealing and continuing in a fresh message; a silent success would instead have it record
    // text as delivered that nobody can see.
    throw new MessageNotEditableError(`[webui] cannot ${op} message ${id}: it is no longer on screen`);
  }

  private conversation(topicId: string): ConversationRef {
    // `kind: 'direct'` even though a lane is set, and that is load-bearing rather than lazy:
    // with `'thread'` the inbound gate would fall through to its mention requirement, and a
    // brand-new topic — no DM, no active session, no @ — would have its FIRST message silently
    // dropped. A DM that has lanes is a shape the gateway already knows (a Telegram DM topic).
    return { platform: this.instance.id, channel: CHANNEL, thread: topicId, kind: 'direct', user: OWNER };
  }

  private channelAllowed(ref: ConversationRef): boolean {
    const allow = this.instance.chat.channels;
    return allow.length === 0 || addressListed(allow, addressOf(ref));
  }
}

/** A browser upload, as the attachment pipeline wants it. */
function toAttachment(file: { name: string; mime: string; data: string }): NonNullable<InboundMessage['attachments']>[number] {
  return {
    type: file.mime.startsWith('image/') ? 'image' : 'file',
    // A `data:` URL, the shape `adapter-telegram` already hands over for every inbound photo —
    // so `daemon/attachment-io.ts` has a branch for it, and the SSRF guard it would otherwise
    // apply has nothing to act on (no host to resolve, no request to make). Writing the bytes
    // to a temp file and passing `file://` was the obvious alternative and is refused outright
    // by that same guard, which admits http(s) only.
    url: `data:${file.mime || 'application/octet-stream'};base64,${file.data}`,
    name: file.name,
    ...(file.mime ? { mime: file.mime } : {}),
  };
}

/** The operator's own message: their markdown, plus a line naming whatever they attached. */
function renderBody(text: string, attachments: ReadonlyArray<{ name?: string }>): string {
  const body = renderWebMarkdown(text);
  if (attachments.length === 0) return body;
  const names = attachments.map((a) => `<span class="chip">${escapeHtml(a.name ?? 'file')}</span>`).join('');
  return `${body}<div class="files">${names}</div>`;
}

export { TopicStore, type Topic } from './topics.js';
