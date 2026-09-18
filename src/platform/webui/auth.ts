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
 * Pure except for `randomUUID` and the injected clock, so the throttle and the expiry are
 * testable without waiting real seconds.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

/** Cookie the session id travels in. Prefixed so it cannot collide on a shared origin. */
export const SESSION_COOKIE = 'aa_webui';

/**
 * How long a session survives without being used.
 *
 * Refreshed on every authenticated request, so an open tab never logs itself out; a week is
 * the window in which a stolen cookie is still worth something. Sessions live in memory
 * only, so a daemon restart logs everyone out regardless — which is the right default for a
 * credential nobody can revoke individually.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface AuthOptions {
  /** The shared secret, as configured (already `${VAR}`-expanded by `loadConfig`). */
  token: string;
  /** Injected for tests; defaults to the wall clock. */
  now?: () => number;
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
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, Attempts>();

  constructor(opts: AuthOptions) {
    this.secret = Buffer.from(opts.token, 'utf8');
    this.now = opts.now ?? Date.now;
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
    const expires = this.sessions.get(id);
    if (expires === undefined) return false;
    const now = this.now();
    if (expires <= now) {
      this.sessions.delete(id);
      return false;
    }
    // Re-insert rather than assign: Map preserves insertion order, and eviction below leans
    // on that to drop the least recently used session instead of an arbitrary one.
    this.sessions.delete(id);
    this.sessions.set(id, now + SESSION_TTL_MS);
    return true;
  }

  /** Drop a session (the page's logout). No-op on an unknown or absent cookie. */
  revoke(cookieHeader: string | undefined): void {
    const id = readCookie(cookieHeader, SESSION_COOKIE);
    if (id) this.sessions.delete(id);
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
    this.sessions.set(id, this.now() + SESSION_TTL_MS);
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
