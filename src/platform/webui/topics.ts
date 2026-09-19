/**
 * The web UI's topics: the list of parallel conversations the page can switch between.
 *
 * Modelled on a Telegram forum / a Feishu topic group — each topic is a lane on the one
 * channel, so each is its own conversation with its own agent session and its own
 * harness-generated name (see `room.ts` for the addressing, and `index.ts` for why the lane
 * rather than a separate channel).
 *
 * ── Why this is persisted, and why it is a file of its own ───────────────────
 * Losing this list is not "the page looks empty after a restart". The daemon's
 * `conversations.json` still holds the agent binding and the per-agent session id under
 * `<instance>#main#<topic id>`, so every one of those contexts would still be alive — just
 * unreachable, because nothing would know the ids any more.
 *
 * It duplicates one field the daemon already stores: `ConversationStore.conversationTitle`
 * keeps a title too. That duplication is forced by the layering rather than chosen —
 * `platform/` may not import `daemon/` — and the two answer different questions. The daemon's
 * is "what is this conversation called", and it does not exist until a turn has run; this one
 * is "which rooms does the page have", and a topic created a second ago with nothing said in
 * it has to be in it. Do not try to merge them.
 *
 * Shape and failure behaviour copied from `daemon/workdir-usage.ts`: write-through, a missing
 * or corrupt file degrades to empty, and it is never worth a crash.
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

/** One topic, as the page lists it. */
export interface Topic {
  id: string;
  /** Empty until something names it — the first message seeds it, the harness replaces it. */
  title: string;
  /** Epoch ms of the last message either way; the switcher orders by it. */
  lastAt: number;
  /** True while an agent turn is actively executing in this topic. */
  running?: boolean;
  /** Monotonic count of messages posted into this topic. */
  msgCount?: number;
  /**
   * Where this topic's conversation is working, when the daemon gave the adapter a way to ask
   * (`PlatformAdapter.useWorkdirLookup`). Both halves are sent because they answer different
   * questions: `name` is the project you recognise at a glance in a 240px column, and `path` is
   * the one that tells two checkouts of the same name apart, so the page hangs it off the title
   * attribute. Derived on every render like `running` and `msgCount` — never persisted, because
   * the daemon's answer is the only true one and a stale copy of it would outlive a `/cd`.
   */
  dir?: { name: string; path: string };
}

/**
 * Ceiling on concurrent topics.
 *
 * A refusal rather than an eviction, deliberately: dropping the oldest topic would orphan a
 * live agent session exactly the way losing this file would, and 64 rooms is already far past
 * the point where a one-line switcher is readable.
 */
const MAX_TOPICS = 64;

/** How much of a first message becomes the placeholder name before the harness names it. */
const SEED_CHARS = 32;

export class TopicStore {
  private readonly topics = new Map<string, Topic>();

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [id, value] of Object.entries(raw)) {
        const topic = toTopic(id, value);
        if (topic) this.topics.set(id, topic);
      }
    } catch {
      /* first run or corrupt file: start with no topics, and create() makes the first one */
    }
  }

  /** Most recently active first — the order the switcher reads in. */
  list(): Topic[] {
    return [...this.topics.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  get(id: string): Topic | undefined {
    return this.topics.get(id);
  }

  has(id: string): boolean {
    return this.topics.has(id);
  }

  /**
   * The topic a client should land on when it named none: the most recent, creating one if
   * this is a brand-new install. The page is never without a room to be in.
   */
  current(): Topic {
    return this.list()[0] ?? this.create();
  }

  create(title = ''): Topic {
    if (this.topics.size >= MAX_TOPICS) {
      throw new Error(`[webui] this instance already has ${MAX_TOPICS} topics; close one before opening another`);
    }
    // Hex, and never a character `formatAddress` gives meaning to: the id travels as the lane
    // half of `main/<id>`, which `parseAddress` splits on `/` and refuses to see twice.
    const topic: Topic = { id: randomBytes(4).toString('hex'), title, lastAt: Date.now() };
    this.topics.set(topic.id, topic);
    this.flush();
    return topic;
  }

  /** Name a topic. This is what `renameThread` lands on, i.e. what the harness decided. */
  rename(id: string, title: string): boolean {
    const topic = this.topics.get(id);
    if (!topic || !title.trim()) return false;
    topic.title = title.trim();
    this.flush();
    return true;
  }

  /** Delete a topic from the store and persist the list. */
  delete(id: string): boolean {
    const topic = this.topics.get(id);
    if (!topic) return false;
    this.topics.delete(id);
    this.flush();
    return true;
  }

  /**
   * Give an unnamed topic a placeholder from the first thing said in it.
   *
   * Without it a run of new topics reads as several identical blanks in the switcher, and the
   * harness's own name does not arrive until a turn has finished (and never at all when
   * `title.llm` is unconfigured). Only ever fills a blank — it must not overwrite a real name.
   */
  seed(id: string, text: string): boolean {
    const topic = this.topics.get(id);
    if (!topic || topic.title) return false;
    const line = text.replace(/\s+/g, ' ').trim();
    if (!line) return false;
    topic.title = line.length > SEED_CHARS ? `${line.slice(0, SEED_CHARS)}…` : line;
    this.flush();
    return true;
  }

  /** Record activity, so the switcher's order means something. */
  touch(id: string, at = Date.now()): void {
    const topic = this.topics.get(id);
    if (!topic || topic.lastAt === at) return;
    topic.lastAt = at;
    this.flush();
  }

  private flush(): void {
    const out: Record<string, Omit<Topic, 'id'>> = {};
    for (const [id, t] of this.topics) out[id] = { title: t.title, lastAt: t.lastAt };
    try {
      fs.mkdirSync(dirOf(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch (e) {
      // Losing the write costs the topic list on the next restart, which is bad but survivable;
      // throwing here would take down the message that triggered it, which is worse.
      console.warn('[webui] could not save the topic list:', e instanceof Error ? e.message : e);
    }
  }
}

function dirOf(file: string): string {
  const at = file.lastIndexOf('/');
  return at <= 0 ? '.' : file.slice(0, at);
}

/** Validate one persisted entry; anything malformed is dropped rather than trusted. */
function toTopic(id: string, value: unknown): Topic | undefined {
  if (!/^[0-9a-f]{8}$/.test(id) || typeof value !== 'object' || value === null) return undefined;
  const rec = value as { title?: unknown; lastAt?: unknown };
  const title = typeof rec.title === 'string' ? rec.title : '';
  const lastAt = typeof rec.lastAt === 'number' && Number.isFinite(rec.lastAt) ? rec.lastAt : 0;
  return { id, title, lastAt };
}
