/**
 * The web UI's conversation: its messages, its subscribers, and both directions of traffic.
 *
 * ONE conversation. The page is a single room; there is no sidebar, no room list and no
 * threads, which is why the adapter declares `thread` and `renameThread` false. A second
 * conversation is a second `platforms:` entry on a second port.
 *
 * Messages live in a bounded in-memory ring that is replayed to a browser on every
 * (re)connect — so a reload restores what is on screen, and a daemon restart does not. The
 * agent's own session is persisted separately (`daemon/conversation-store.ts`) and is
 * unaffected either way, which means after a restart the page is empty while the agent still
 * remembers everything. That asymmetry is deliberate and documented in the README.
 *
 * Deliberately free of HTTP: everything here is exercisable without opening a port, which is
 * what the adapter's tests drive.
 */
import { randomUUID } from 'node:crypto';

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

/** A `platforms.<id>` entry of type `webui`, plus its map key. */
export type WebuiInstance = WebuiPlatformConfig & { id: string };

/**
 * The single conversation's channel id, and the single operator's user id.
 *
 * Constants rather than config: they are not addresses of anything real, they are the names
 * this platform answers to. `access.allowFrom` matches `<instance id>:owner`, and the
 * `--channel` flag of a reverse command takes `main`.
 */
export const CHANNEL = 'main';
export const OWNER = 'owner';

/**
 * How many messages the page remembers across a reload.
 *
 * Bounded because it is memory in a daemon that runs for weeks. An id evicted from here can
 * no longer be edited, which is a real event the outbound path has to report honestly rather
 * than absorb — see `mustFind`.
 */
const MAX_MESSAGES = 500;

/** How many of the agent's sent files stay downloadable. Same reasoning, much smaller. */
const MAX_DOWNLOADS = 200;

/** One message as the room holds it: what the page renders, plus what produced it. */
interface Stored {
  msg: WebMessage;
  /** The markdown the html was rendered from — what `fetch-messages` must hand back. */
  text: string;
}

/**
 * The conversation: its messages, its subscribers, and the two directions of traffic.
 *
 * Separate from the HTTP server on purpose. Everything here is exercisable without opening a
 * port, which is why the adapter's tests drive this class directly.
 */
export class WebRoom {
  private seq = 0;
  private readonly stored = new Map<string, Stored>();
  private readonly clients = new Set<(ev: WebEvent) => void>();
  private readonly downloads = new Map<string, { path: string; name: string }>();
  private commands: SlashCommandSpec[] = [];
  private typing = false;

  private onMsg: ((m: InboundMessage) => void) | null = null;
  private onBtn: ((ev: ButtonInteraction) => void) | null = null;

  constructor(private readonly instance: WebuiInstance) {}

  // ── Subscribers ────────────────────────────────────────────────────────────

  /**
   * Attach a client. It is handed the whole room first, then every change.
   *
   * The full replay is what makes a reconnect indistinguishable from a first load, which
   * matters more here than it looks: the browser's `EventSource` reconnects on its own after
   * any blip, mid-turn included, and a client that resumed from "whatever arrives next" would
   * show a reply starting from its middle.
   */
  subscribe(send: (ev: WebEvent) => void): () => void {
    this.clients.add(send);
    // Through `deliver` like every other write, not straight to `send`: a socket can die
    // between being accepted and being written to, and the replay is the FIRST write. Calling
    // it directly threw that failure out of subscribe and into the request handler.
    if (this.deliver(send, { t: 'sync', messages: [...this.stored.values()].map((s) => s.msg), commands: this.commands })) {
      if (this.typing) this.deliver(send, { t: 'typing', on: true });
      console.log(`[webui] client attached (${this.clients.size} watching)`);
    }
    return () => {
      if (this.clients.delete(send)) console.log(`[webui] client left (${this.clients.size} watching)`);
    };
  }

  /** Whether anyone is watching. Reported at startup so "answering into a void" is visible. */
  get watchers(): number {
    return this.clients.size;
  }

  private broadcast(ev: WebEvent): void {
    for (const send of this.clients) this.deliver(send, ev);
  }

  /**
   * Write to one client, dropping it if it fails. Returns whether it is still attached.
   *
   * The only place an event reaches a client, so one wedged socket can never take a turn down
   * with it — an outbound failure here is a browser that went away, not a problem with the
   * message.
   */
  private deliver(send: (ev: WebEvent) => void, ev: WebEvent): boolean {
    try {
      send(ev);
      return true;
    } catch (e) {
      console.warn('[webui] dropping a client that failed to receive:', e instanceof Error ? e.message : e);
      this.clients.delete(send);
      return false;
    }
  }

  // ── Outbound (daemon → page) ───────────────────────────────────────────────

  /**
   * Add a message to the room.
   *
   * Resolves whether or not anybody is connected, and that is a deliberate contract rather
   * than an oversight: the ring is the conversation, the clients are a fan-out of it. An
   * adapter that failed when no browser was open would fail every turn started before someone
   * opened the page — and the daemon would answer that failure by posting "❌ This turn
   * failed" into the same empty room.
   */
  post(part: Omit<WebMessage, 'id' | 'at' | 'buttons' | 'reactions'> & { buttons?: ButtonSpec[] }, text: string): WebMessage {
    const msg: WebMessage = {
      ...part,
      id: this.nextId(),
      at: Date.now(),
      buttons: part.buttons ?? [],
      reactions: [],
    };
    if (this.stored.size >= MAX_MESSAGES) {
      const oldest = this.stored.keys().next().value;
      if (oldest !== undefined) this.stored.delete(oldest);
    }
    this.stored.set(msg.id, { msg, text });
    this.broadcast({ t: 'msg', msg });
    return msg;
  }

  /** Replace a message's body and buttons in place. Throws when it is no longer held. */
  revise(id: string, text: string, buttons?: ButtonSpec[]): void {
    const rec = this.mustFind(id, 'edit');
    rec.text = text;
    rec.msg = { ...rec.msg, html: renderWebMarkdown(text), ...(buttons ? { buttons } : {}) };
    this.stored.set(id, rec);
    this.broadcast({ t: 'msg', msg: rec.msg });
  }

  /** Remove a message. Removing one that is already gone is success, not an error. */
  remove(id: string): void {
    if (!this.stored.delete(id)) return;
    this.broadcast({ t: 'del', id });
  }

  /**
   * Add or remove a lifecycle reaction (👀 / ✅ / ❌).
   *
   * Silent on an unknown id rather than throwing, unlike an edit. Reactions are best-effort
   * decoration — every caller already wraps them in a catch — and a reaction that cannot land
   * costs the user nothing, whereas an edit that cannot land costs them the text.
   */
  react(id: string, emoji: string, on: boolean): void {
    const rec = this.stored.get(id);
    if (!rec) return;
    const kept = rec.msg.reactions.filter((e) => e !== emoji);
    rec.msg = { ...rec.msg, reactions: on ? [...kept, emoji] : kept };
    this.stored.set(id, rec);
    this.broadcast({ t: 'react', id, emoji, on });
  }

  setTyping(on: boolean): void {
    if (this.typing === on) return;
    this.typing = on;
    this.broadcast({ t: 'typing', on });
  }

  setCommands(commands: SlashCommandSpec[]): void {
    this.commands = commands;
    this.broadcast({ t: 'commands', commands });
  }

  /** The rendered body of a message, for quoting it. Empty when it is no longer held. */
  htmlOf(id: string): string {
    return this.stored.get(id)?.msg.html ?? '';
  }

  /**
   * Register a file the agent sent, and return the page-relative URL that serves it.
   *
   * The path never reaches the browser and the browser never names one: it gets an opaque
   * token that this map alone can resolve. The agent already has full tool access, so this is
   * not protecting the filesystem from the agent — it is keeping the page from becoming a way
   * to ask the daemon for an arbitrary path.
   *
   * Relative (`f/<token>`, no leading slash) so the page works unchanged when a reverse proxy
   * mounts it under a sub-path.
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

  // ── Inbound (page → daemon) ────────────────────────────────────────────────

  onMessage(handler: (m: InboundMessage) => void): void {
    this.onMsg = handler;
  }

  onButton(handler: (ev: ButtonInteraction) => void): void {
    this.onBtn = handler;
  }

  /** The operator sent something. Echo it into the room, then hand it to the daemon. */
  submit(req: SendRequest): void {
    const attachments = (req.files ?? []).map(toAttachment);
    const text = req.text.trim();
    // The inbound gate drops an empty message anyway; stopping here keeps an accidental
    // Enter from appearing in the transcript as a blank bubble the agent never saw.
    if (!text && attachments.length === 0) return;
    const msg = this.post({ own: true, html: renderBody(req.text, attachments) }, req.text);
    const inbound: InboundMessage = {
      conversation: this.conversation(),
      platformType: 'webui',
      messageId: msg.id,
      content: req.text,
      timestamp: msg.at,
      ...(attachments.length > 0 ? { attachments } : {}),
      authorIsBot: false,
    };
    // The listen allowlist, which `satori-core` applies for every other platform and this
    // adapter therefore has to apply for itself. With one channel it can only allow or mute
    // the whole UI — but a config field that parses and does nothing is worse than one that
    // does something small, and this is the field the operator would reach for to park an
    // instance without deleting it.
    if (!this.channelAllowed(inbound.conversation)) {
      console.log(`[webui] "${this.instance.id}": dropped a message — chat.channels does not list ${CHANNEL}`);
      return;
    }
    console.log(`[in] ${describeConversation(inbound.conversation)} @${OWNER}: ${text.slice(0, 50).replace(/\n/g, ' ')}`);
    this.onMsg?.(inbound);
  }

  /**
   * A button was clicked.
   *
   * The message id is checked against the ring before it is forwarded. It arrives from the
   * page, and the daemon's click handlers edit the message it names — so an id nothing here
   * holds is either a stale tab or a hand-made request, and neither should reach a writer.
   */
  click(req: ClickRequest): boolean {
    if (!this.stored.has(req.messageId)) return false;
    this.onBtn?.({
      conversation: this.conversation(),
      messageId: req.messageId,
      buttonId: req.buttonId,
    });
    return true;
  }

  /** Replay for `agent-anywhere fetch-messages`, oldest first, in the shape history has. */
  history(opts: { limit?: number; before?: string }): InboundMessage[] {
    const all = [...this.stored.values()];
    const cut = opts.before ? all.findIndex((s) => s.msg.id === opts.before) : -1;
    const upto = cut >= 0 ? all.slice(0, cut) : all;
    const limited = opts.limit !== undefined ? upto.slice(-opts.limit) : upto;
    return limited.map((s) => ({
      conversation: this.conversation(),
      platformType: 'webui',
      messageId: s.msg.id,
      content: s.text,
      timestamp: s.msg.at,
      authorIsBot: !s.msg.own,
    }));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Ids are a monotonic counter and are never reused.
   *
   * Not cosmetic: the outbound pacer coalesces edits into a slot keyed
   * `edit:<channel>:<messageId>`, and with a single channel that key IS the id. A reused id
   * would make one message's edits silently supersede another's.
   */
  private nextId(): string {
    this.seq += 1;
    return `w${this.seq}`;
  }

  private mustFind(id: string, op: string): Stored {
    const rec = this.stored.get(id);
    if (rec) return rec;
    // MessageNotEditableError, specifically, and not a generic failure: it means "this message
    // will never accept another edit", which is exactly true of one the ring has evicted. The
    // writers answer it by sealing and continuing in a fresh message (StreamBuffer) or a fresh
    // bubble (ToolRenderer). A silent success here would instead have StreamBuffer record the
    // text as delivered, and everything after the eviction point would vanish under a ✅.
    throw new MessageNotEditableError(`[webui] cannot ${op} message ${id}: it is no longer on screen`);
  }

  private conversation(): ConversationRef {
    return { platform: this.instance.id, channel: CHANNEL, kind: 'direct', user: OWNER };
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
    // A `data:` URL, which is the shape `adapter-telegram` already hands over for every
    // inbound photo — so `daemon/attachment-io.ts` has a branch for it, and the SSRF guard it
    // would otherwise apply has nothing to act on (no host to resolve, no request to make).
    // Writing the bytes to a temp file and passing `file://` was the obvious alternative and
    // is refused outright by that same guard, which admits http(s) only.
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
