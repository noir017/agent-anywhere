/**
 * Who may use the web UI.
 *
 * One shared secret from config, exchanged once for a session cookie. That is the entire
 * model, and it is worth being blunt about what it does and does not buy: behind this page
 * is an agent the daemon grants full tool access (`AGENTS.md`, security invariant 1), and
 * the config binds the port to every interface by default. This module is the only thing
 * between the network and that agent, so it is written to the same standard as
 * `ipc/server.ts` — constant-time comparison, bounded state, no secret in a log line.
 *
 * What it is NOT: per-person identity. Everyone who knows the secret is the same operator
 * as far as `access.allowFrom` is concerned (the adapter stamps one fixed user id). Two
 * people sharing the secret share the conversation, by design — the alternative is an
 * account system, which is a different product.
 *
 * Pure except for `randomUUID`, the injected clock and the injected store, so the throttle
 * and the expiry are testable without waiting real seconds or touching a disk.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

/** Cookie the session id travels in. Prefixed so it cannot collide on a shared origin. */
export const SESSION_COOKIE = 'aa_webui';

/**
 * How long a session survives without being used.
 *
 * Refreshed on every authenticated request, so an open tab never logs itself out; a week is
 * the window in which a stolen cookie is still worth something.
 *
 * Sessions used to live in memory only, on the theory that a restart logging everyone out was
 * the safe default. In practice every release is a restart (the image is rebuilt and the
 * container replaced), so the operator retyped the secret after every update — and a door
 * people are made to open that often ends up with its key on a sticky note. They now persist
 * (see `SessionStore`); what a restart no longer does, rotating the token still does.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How stale a session's recorded expiry may get before a check rewrites it.
 *
 * `check` runs on every request — each send, each `EventSource` reconnect — and writing the
 * store on each would turn reading a chat into a stream of disk writes. Refreshing only once
 * the expiry has slid by an hour costs at most an hour off a week-long lifetime.
 */
const REFRESH_SLACK_MS = 60 * 60 * 1000;

/** Bound on concurrent sessions; the oldest is evicted past it. One operator, a few tabs. */
const MAX_SESSIONS = 64;

/** Failed logins tolerated from one source before it is locked out, and for how long. */
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 60_000;
const BLOCK_MS = 60_000;

/** Bound on tracked sources, so a spray from many addresses cannot grow this without limit. */
const MAX_SOURCES = 1024;

export type LoginResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'bad-token' }
  | { ok: false; reason: 'throttled'; retryAfterSec: number };

/**
 * Where sessions outlive the process. Keyed by `digest` (below), never by the id itself.
 *
 * An interface rather than a path so this module stays testable without a filesystem; the
 * adapter wires `fileSessionStore`.
 */
export interface SessionStore {
  load(): Record<string, number>;
  save(sessions: Record<string, number>): void;
}

export interface AuthOptions {
  /** The shared secret, as configured (already `${VAR}`-expanded by `loadConfig`). */
  token: string;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
  /** Absent means memory only: a restart logs everyone out. */
  store?: SessionStore;
}

interface Attempts {
  fails: number;
  /** When the current counting window started, or when a block expires. */
  since: number;
  blockedUntil: number;
}

export class WebAuth {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly store: SessionStore | undefined;
  /** `digest(id)` → expiry. Insertion order is recency order; see `check`. */
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, Attempts>();

  constructor(opts: AuthOptions) {
    this.secret = Buffer.from(opts.token, 'utf8');
    this.now = opts.now ?? Date.now;
    this.store = opts.store;
    this.restore();
  }

  /**
   * Exchange the shared secret for a session id.
   *
   * `source` is whatever identifies the caller for throttling (the remote address). It is
   * only ever a map key here — never logged, never compared for authorization — because
   * behind a reverse proxy every request shares one, and treating that as identity would be
   * a lock with no key.
   */
  login(secret: string, source: string): LoginResult {
    const blocked = this.blockedFor(source);
    if (blocked > 0) return { ok: false, reason: 'throttled', retryAfterSec: Math.ceil(blocked / 1000) };
    if (!this.matches(secret)) {
      this.noteFailure(source);
      return { ok: false, reason: 'bad-token' };
    }
    this.attempts.delete(source);
    return { ok: true, sessionId: this.open() };
  }

  /**
   * Whether a request's `Cookie` header carries a live session — and refresh it if so.
   *
   * Takes the raw header rather than a parsed id so that every caller goes through the same
   * cookie parsing. A second parser somewhere else is how a path ends up accepting a cookie
   * this one would have rejected.
   */
  check(cookieHeader: string | undefined): boolean {
    const id = readCookie(cookieHeader, SESSION_COOKIE);
    if (!id) return false;
    const key = this.digest(id);
    const expires = this.sessions.get(key);
    if (expires === undefined) return false;
    const now = this.now();
    if (expires <= now) {
      this.sessions.delete(key);
      this.persist();
      return false;
    }
    const next = now + SESSION_TTL_MS;
    if (next - expires < REFRESH_SLACK_MS) return true;
    // Re-insert rather than assign: Map preserves insertion order, and eviction below leans
    // on that to drop the least recently used session instead of an arbitrary one.
    this.sessions.delete(key);
    this.sessions.set(key, next);
    this.persist();
    return true;
  }

  /** Drop a session (the page's logout). No-op on an unknown or absent cookie. */
  revoke(cookieHeader: string | undefined): void {
    const id = readCookie(cookieHeader, SESSION_COOKIE);
    if (id && this.sessions.delete(this.digest(id))) this.persist();
  }

  /**
   * What a session is remembered by: an HMAC of its id under the shared secret.
   *
   * Two properties, both deliberate. The store never holds a usable cookie, so reading the file
   * is not the same as being signed in. And the key is the secret, so changing `token` makes
   * every remembered session unmatchable at once — the "log everyone out" a restart used to do
   * implicitly is now the explicit act of rotating the credential, which is when it is wanted.
   */
  private digest(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('hex');
  }

  /** Load what the store remembers, dropping anything malformed or already expired. */
  private restore(): void {
    if (!this.store) return;
    const now = this.now();
    const live = Object.entries(this.store.load())
      .filter(([k, v]) => /^[0-9a-f]{64}$/.test(k) && typeof v === 'number' && v > now)
      // Oldest expiry first, so Map order means recency again and the cap trims the stalest.
      .sort((a, b) => a[1] - b[1])
      .slice(-MAX_SESSIONS);
    for (const [k, v] of live) this.sessions.set(k, v);
  }

  private persist(): void {
    this.store?.save(Object.fromEntries(this.sessions));
  }

  /**
   * Compare the offered secret in constant time.
   *
   * `timingSafeEqual` needs equal lengths, so length is checked first and therefore leaks —
   * accepted, and the same trade `conversation-token-registry.ts` documents: the length of a
   * secret the operator chose is not what an attacker is missing.
   */
  private matches(offered: string): boolean {
    const probe = Buffer.from(offered, 'utf8');
    if (probe.length !== this.secret.length) return false;
    return timingSafeEqual(probe, this.secret);
  }

  private open(): string {
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const id = randomUUID();
    this.sessions.set(this.digest(id), this.now() + SESSION_TTL_MS);
    this.persist();
    return id;
  }

  /** Remaining block in ms for a source, 0 when it may try. */
  private blockedFor(source: string): number {
    const rec = this.attempts.get(source);
    if (!rec) return 0;
    return Math.max(0, rec.blockedUntil - this.now());
  }

  private noteFailure(source: string): void {
    const now = this.now();
    if (this.attempts.size >= MAX_SOURCES && !this.attempts.has(source)) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
    const rec = this.attempts.get(source);
    // A window that has gone quiet starts over: the limit is about a burst of guesses, not
    // about five typos spread across an afternoon.
    if (!rec || now - rec.since > FAIL_WINDOW_MS) {
      this.attempts.set(source, { fails: 1, since: now, blockedUntil: 0 });
      return;
    }
    rec.fails += 1;
    if (rec.fails >= FAIL_LIMIT) {
      rec.blockedUntil = now + BLOCK_MS;
      rec.fails = 0;
      rec.since = now;
    }
  }
}

/**
 * Read one cookie out of a `Cookie` header.
 *
 * Hand-rolled rather than pulled in: the header is a `; `-separated list of `name=value`,
 * the value here is a UUID this process minted, and a dependency for that would be its own
 * kind of surface.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || undefined;
  }
  return undefined;
}

/**
 * The `Set-Cookie` value for a new session.
 *
 * `HttpOnly` keeps it out of reach of any script that does get injected; `SameSite=Strict`
 * is the CSRF defence, since every state-changing route here is a POST the page makes to its
 * own origin. `Secure` only when the request actually arrived over TLS — setting it
 * unconditionally would make the cookie silently undeliverable on a plain-http LAN
 * deployment, which is the common one.
 */
export function sessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * A `SessionStore` on one JSON file.
 *
 * `0600` and written through a temp file + rename: the contents are not cookies (see
 * `WebAuth.digest`), but they are still the list of who is signed in, and a torn write read back
 * as garbage would log everyone out — the thing this file exists to prevent. Both failure
 * directions degrade to "memory only" with a warning rather than throwing: a login must not fail
 * because a disk is full, and a daemon must not refuse to start over an unreadable file.
 */
export function fileSessionStore(file: string): SessionStore {
  return {
    load() {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[webui] could not read saved sessions:', e instanceof Error ? e.message : e);
        }
        return {};
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        // Entries are validated one by one in `WebAuth.restore`; this only rules out a non-object.
        return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
      } catch {
        console.warn('[webui] saved sessions are not valid JSON; starting with none');
        return {};
      }
    },
    save(sessions) {
      const tmp = `${file}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (e) {
        console.warn('[webui] could not save sessions:', e instanceof Error ? e.message : e);
      }
    },
  };
}
