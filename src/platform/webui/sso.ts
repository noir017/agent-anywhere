/**
 * Who the proxy in front says you are.
 *
 * `auth.ts` is the other door: one shared secret, no identity, and nothing an operator can
 * revoke for one person. This one is for a deployment that already has an identity-aware proxy
 * in front of the page — Cloudflare Access, Teleport's Application Service — which has
 * authenticated a *person* with SSO and MFA and states who it was in a JWT it signed. Verifying
 * that signature is a better door than a password typed once in a YAML file: it expires, it
 * carries a name, and revoking it happens where the operator already manages people.
 *
 * Both of those proxies do the same thing, which is why one module covers both: a JWT in a
 * request header, RS256, public keys at a JWKS URL.
 *
 *   - Cloudflare Access: `Cf-Access-Jwt-Assertion` (also the `CF_Authorization` cookie),
 *     keys at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` is the
 *     application's AUD tag, and the person is the `email` claim.
 *   - Teleport: `Teleport-Jwt-Assertion`, keys at `https://<proxy>/.well-known/jwks.json`,
 *     `aud` is the app's public address, and the person is `username` (`sub` is the same
 *     string there, unlike Cloudflare where it is an opaque uuid).
 *     — https://goteleport.com/docs/enroll-resources/application-access/jwt/introduction/
 *       (read 2026-09-21)
 *
 * ── Why a source allowlist is required and not optional ──────────────────────
 * A header is evidence only because of the signature on it — anything that can open a socket to
 * this port can *write* the header, and on the deployment this was built for the port is
 * reachable from a whole VPN mesh, not just from the proxy. The signature is what refuses those,
 * so `from` is not what makes this safe. It is what keeps a mistake in everything above from
 * being fatal: a JWKS URL pointed at the wrong tenant, an `audience` left matching some other
 * app of the same issuer, a bug in this file. Requiring it costs the operator one line of YAML
 * and turns "my verification must be perfect" into "and you must also be the proxy". The same
 * belt-and-braces the IPC socket gets in `ipc/server.ts`: 0600 *and* a token.
 *
 * Refusals name the source address in the log precisely because that line is how an operator
 * discovers what to put in `from`. It is not a secret; the JWT never appears in a log line,
 * because that one is a bearer credential.
 *
 * Pure except for `fetch`, the clock and the key cache — all injected, so the tests sign their
 * own tokens against their own keypair and never open a socket.
 */
import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { BlockList, isIPv6 } from 'node:net';
import type { IncomingMessage } from 'node:http';

import { readCookie } from './auth.js';

/** Tolerance on `exp`/`nbf`, for the ordinary case of two machines a few seconds apart. */
const CLOCK_SKEW_MS = 60_000;

/** Refuse a JWKS document larger than this rather than parse whatever a redirect landed on. */
const MAX_JWKS_BYTES = 64 * 1024;

/** How long to wait on the identity provider before giving up on a request. */
const JWKS_TIMEOUT_MS = 5_000;

/**
 * Key rotation, from both ends.
 *
 * An unknown `kid` is the signal that the provider rotated, so it triggers a refetch — but that
 * is a remote-controlled fetch, hence the cooldown: a stream of junk tokens with random `kid`s
 * must not turn this daemon into a load generator pointed at the provider. Ten seconds is short
 * deliberately, because the cooldown is also how long a real rotation is refused for; it bounds
 * the provider's worst case at six requests a minute, which is nothing, and bounds a rotation's
 * blast radius at ten seconds of retries the page makes on its own anyway.
 *
 * The max age is the other end of it, so a key withdrawn while nothing was signed by its
 * replacement still leaves eventually.
 */
const JWKS_REFETCH_COOLDOWN_MS = 10_000;
const JWKS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Why a request was not accepted. Named so the log line can say something actionable. */
export type SsoRefusal =
  | 'no-assertion'
  | 'source'
  | 'malformed'
  | 'alg'
  | 'unknown-key'
  | 'signature'
  | 'expired'
  | 'not-yet-valid'
  | 'issuer'
  | 'audience'
  | 'claim'
  | 'jwks-unavailable';

export type SsoResult = { ok: true; who: string } | { ok: false; reason: SsoRefusal };

export interface SsoOptions {
  /** Request header carrying the assertion, e.g. `Cf-Access-Jwt-Assertion`. */
  header: string;
  /** Cookie to fall back to when the header is absent, e.g. `CF_Authorization`. */
  cookie?: string;
  jwksUrl: string;
  /** Exact `iss` the token must carry. */
  issuer: string;
  /** Value that must appear in `aud` — a string there, or one entry of an array. */
  audience: string;
  /** Claim naming the person: `email` for Cloudflare Access, `username` for Teleport. */
  claim: string;
  /** Who may in. Compared case-insensitively, because an email address is. */
  allow: readonly string[];
  /** CIDRs the request must come from. Non-empty; see the header comment. */
  from: readonly string[];
  now?: () => number;
  fetch?: typeof globalThis.fetch;
}

export class WebSso {
  private readonly opts: SsoOptions;
  private readonly now: () => number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sources = new BlockList();
  private readonly allow: ReadonlySet<string>;
  private keys = new Map<string, KeyObject>();
  private keysFetchedAt = 0;
  private lastAttemptAt = 0;
  /** In flight refetch, shared: a burst of requests after a rotation is one fetch, not N. */
  private refreshing: Promise<void> | undefined;

  constructor(opts: SsoOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.allow = new Set(opts.allow.map((a) => a.trim().toLowerCase()));
    for (const cidr of opts.from) addSubnet(this.sources, cidr);
  }

  /**
   * Identify the person behind a request, or say why not.
   *
   * Async because a rotation means fetching keys, and there is nowhere else to do it: the
   * alternative is a background timer refreshing keys nobody is asking about, which fails
   * silently when the URL is wrong instead of failing on the request that needed it.
   */
  async identify(req: IncomingMessage): Promise<SsoResult> {
    if (!this.fromTrustedSource(req.socket.remoteAddress)) return { ok: false, reason: 'source' };
    const raw = this.assertion(req);
    if (!raw) return { ok: false, reason: 'no-assertion' };
    return this.verify(raw);
  }

  /** Whether the connection came from the proxy. An address Node could not give us is not it. */
  private fromTrustedSource(address: string | undefined): boolean {
    if (!address) return false;
    return this.sources.check(address, isIPv6(address) ? 'ipv6' : 'ipv4');
  }

  /** The assertion, from the header the proxy sets or the cookie it also sets. */
  private assertion(req: IncomingMessage): string | undefined {
    const header = req.headers[this.opts.header.toLowerCase()];
    const value = Array.isArray(header) ? header[0] : header;
    if (value) return value;
    // The cookie exists for the handshake the header may not survive: a WebSocket upgrade goes
    // through a different path in both proxies, and Cloudflare Access sets `CF_Authorization`
    // on the browser for exactly that reason.
    return this.opts.cookie ? readCookie(req.headers.cookie, this.opts.cookie) : undefined;
  }

  private async verify(raw: string): Promise<SsoResult> {
    const parts = raw.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [rawHead, rawBody, rawSig] = parts as [string, string, string];
    const head = decodeJson(rawHead);
    const body = decodeJson(rawBody);
    if (!head || !body) return { ok: false, reason: 'malformed' };
    // Only RS256, and refused by name rather than by "whatever the key turns out to be". `none`
    // and an HMAC whose "key" is the public key are the two classic ways a JWT verifier is
    // talked out of verifying anything; neither is reachable if the algorithm is not negotiable.
    if (head['alg'] !== 'RS256') return { ok: false, reason: 'alg' };
    const kid = typeof head['kid'] === 'string' ? head['kid'] : '';
    const key = await this.keyFor(kid);
    if (!key) return { ok: false, reason: this.keys.size === 0 ? 'jwks-unavailable' : 'unknown-key' };
    if (!rsaVerify(`${rawHead}.${rawBody}`, rawSig, key)) return { ok: false, reason: 'signature' };
    return this.checkClaims(body);
  }

  /**
   * Claims, checked after the signature and never before.
   *
   * Order matters for more than tidiness: every field below is attacker-supplied until the
   * signature says otherwise, and a verifier that decides "this issuer is fine" on an unverified
   * payload has already made its decision by the time it checks.
   */
  private checkClaims(body: Record<string, unknown>): SsoResult {
    const now = this.now();
    const exp = typeof body['exp'] === 'number' ? body['exp'] * 1000 : 0;
    // A token with no expiry is refused by the same branch as an expired one: `exp` is not
    // optional for a credential that travels in a header.
    if (exp <= now - CLOCK_SKEW_MS) return { ok: false, reason: 'expired' };
    const nbf = typeof body['nbf'] === 'number' ? body['nbf'] * 1000 : 0;
    if (nbf > now + CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' };
    if (body['iss'] !== this.opts.issuer) return { ok: false, reason: 'issuer' };
    // `aud` is a string in Teleport's tokens and an array in Cloudflare's — the JWT spec allows
    // both, and getting this wrong in the permissive direction accepts a token minted for a
    // different application of the same issuer.
    const aud = body['aud'];
    const auds = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
    if (!auds.includes(this.opts.audience)) return { ok: false, reason: 'audience' };
    const who = body[this.opts.claim];
    if (typeof who !== 'string' || !this.allow.has(who.trim().toLowerCase())) {
      return { ok: false, reason: 'claim' };
    }
    return { ok: true, who };
  }

  /** The signing key for a `kid`, refetching once when it is one we have not seen. */
  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const known = this.keys.get(kid);
    if (known && this.now() - this.keysFetchedAt < JWKS_MAX_AGE_MS) return known;
    await this.refresh();
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (this.now() - this.lastAttemptAt < JWKS_REFETCH_COOLDOWN_MS) return;
    this.lastAttemptAt = this.now();
    this.refreshing = this.fetchKeys().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Replace the key set, or keep the one we have.
   *
   * A provider that is briefly unreachable must not log everyone out: the keys already held are
   * still the right ones, and dropping them would turn a blip at the identity provider into a
   * dead page. So a failure here is logged and the cache is left alone.
   */
  private async fetchKeys(): Promise<void> {
    try {
      this.keys = await loadJwks(this.opts.jwksUrl, this.fetch);
      this.keysFetchedAt = this.now();
    } catch (e) {
      console.warn(`[webui] could not refresh signing keys from ${this.opts.jwksUrl}: ${message(e)}`);
    }
  }
}

/**
 * Fetch and parse a JWKS document, throwing a sentence an operator can act on.
 *
 * Exported because `doctor` runs exactly this and reports what it found: "the login token is
 * local, nothing to validate online" stopped being the whole truth the moment a second door
 * could be pointed at a URL with a typo in it.
 */
export async function loadJwks(url: string, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<Map<string, KeyObject>> {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const keys = parseJwks(JSON.parse(await readCapped(res)) as unknown);
  if (keys.size === 0) throw new Error('no usable RS256 keys');
  return keys;
}

/**
 * Read a response body, refusing one that is too large *while* reading it.
 *
 * `await res.text()` would buffer the whole thing first and only then measure it, which makes
 * the cap a report rather than a limit — and the fetch on the other end of this is reachable,
 * once per cooldown, by anyone who can send an assertion with an unfamiliar `kid`. Counting
 * bytes as they arrive is the difference between a bounded read and an allocation an endpoint
 * can choose the size of. `.length` on the decoded string would also have been UTF-16 units
 * rather than bytes; this counts bytes.
 */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_JWKS_BYTES) throw new Error('JWKS is implausibly large');
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JWKS_BYTES) {
      await reader.cancel();
      throw new Error('JWKS is implausibly large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Add one CIDR to a `BlockList`.
 *
 * `BlockList` is `node:net`'s, so the prefix arithmetic — including an IPv4-mapped address like
 * `::ffff:10.0.0.2` matching an IPv4 subnet, which is what Node hands us for an IPv4 client on a
 * dual-stack listener — is not hand-rolled here. A bare address with no `/` is one host.
 *
 * The prefix is parsed strictly rather than with `Number()`, and that is the whole reason this
 * function is not three lines. `Number('')` is 0, so `"203.0.113.7/"` — a plausible typo, and
 * one the config schema is happy with — would become a `/0` rule matching **every address on
 * the internet**. Every other malformation here throws; that one would have failed open, in the
 * one field whose entire job is to fail closed.
 */
function addSubnet(list: BlockList, cidr: string): void {
  const slash = cidr.indexOf('/');
  const address = slash < 0 ? cidr : cidr.slice(0, slash);
  const type = isIPv6(address) ? 'ipv6' : 'ipv4';
  const max = type === 'ipv6' ? 128 : 32;
  let bits = max;
  if (slash >= 0) {
    const suffix = cidr.slice(slash + 1);
    if (!/^\d{1,3}$/.test(suffix)) throw new Error(`sso.from: "${cidr}" has no usable prefix length`);
    bits = Number(suffix);
    if (bits > max) throw new Error(`sso.from: "${cidr}" is not a ${type} prefix`);
  }
  list.addSubnet(address, bits, type);
}

/** Every RS256 signing key in a JWKS document, by `kid`. Anything else is skipped, not fatal. */
function parseJwks(doc: unknown): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  const keys = (doc as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return out;
  for (const entry of keys) {
    const jwk = entry as { kty?: unknown; kid?: unknown; alg?: unknown; use?: unknown };
    if (jwk.kty !== 'RSA') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (typeof jwk.kid !== 'string') continue;
    try {
      // The JWK goes to `createPublicKey` as-is rather than being picked apart into `n`/`e`
      // here: the import is the validation, and a hand-rolled one would be a second opinion
      // about what a valid RSA key is.
      out.set(jwk.kid, createPublicKey({ key: entry as JsonWebKey, format: 'jwk' }));
    } catch {
      // A key we cannot import is a key we cannot verify with. Skipping it leaves the others
      // usable, which is the difference between one broken entry and a page nobody can open.
    }
  }
  return out;
}

function rsaVerify(signed: string, signature: string, key: KeyObject): boolean {
  try {
    return createVerify('RSA-SHA256').update(signed).verify(key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** Decode one base64url JWT segment as a JSON object, or `undefined` if it is not one. */
function decodeJson(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
