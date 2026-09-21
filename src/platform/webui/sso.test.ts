import { createSign, createHmac, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { WebSso, type SsoOptions } from './sso.js';

/**
 * One keypair for the whole file: the provider's. Generating a 2048-bit key costs real
 * milliseconds and nothing here needs a second one — except the forgery tests, which need a key
 * that is NOT this one, and that is what `otherKey` is.
 */
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

const NOW = 1_800_000_000_000;
const JWKS_URL = 'https://idp.example/certs';

/** The provider's published key set, in the shape both Cloudflare Access and Teleport serve. */
function jwksFor(kid: string, key: KeyObject = provider.publicKey): string {
  return JSON.stringify({ keys: [{ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

/** A signed assertion. Every deviation a test wants is a field of `opts`, so the happy path stays one call. */
function assertion(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; alg?: string; key?: KeyObject; signature?: string } = {}
): string {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = b64({
    iss: 'https://idp.example',
    aud: 'app-aud-tag',
    email: 'Operator@Example.com',
    exp: Math.floor(NOW / 1000) + 3600,
    ...claims,
  });
  const sig =
    opts.signature ?? createSign('RSA-SHA256').update(`${head}.${body}`).sign(opts.key ?? provider.privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function request(headers: Record<string, string>, remoteAddress = '10.0.0.2'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

/** A verifier whose clock and provider are the test's. Returns the fetch spy too — several tests count calls. */
function makeSso(
  over: Partial<SsoOptions> = {},
  jwks: () => string | Promise<string> = () => jwksFor('k1')
): { sso: WebSso; fetched: () => number; fail: (yes: boolean) => void } {
  let calls = 0;
  let failing = false;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    if (failing) throw new Error('provider unreachable');
    // No `body`, so `loadJwks` falls back to `text()`; the capped read over a real body is
    // exercised by `scripts/verify-sso.mts` against a real server.
    return { ok: true, status: 200, headers: new Headers(), text: async () => jwks() } as Response;
  });
  const sso = new WebSso({
    header: 'Cf-Access-Jwt-Assertion',
    jwksUrl: JWKS_URL,
    issuer: 'https://idp.example',
    audience: 'app-aud-tag',
    claim: 'email',
    allow: ['operator@example.com'],
    from: ['10.0.0.0/24'],
    now: () => NOW,
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    ...over,
  });
  return { sso, fetched: () => calls, fail: (yes) => { failing = yes; } };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('WebSso: the happy path', () => {
  it('accepts a signed assertion from the proxy and names the person', async () => {
    const { sso } = makeSso();
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).toEqual({
      ok: true,
      who: 'Operator@Example.com',
    });
  });

  it('matches the allowlist case-insensitively, because an email address is', async () => {
    const { sso } = makeSso({ allow: ['OPERATOR@EXAMPLE.COM'] });
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }));
    expect(res.ok).toBe(true);
  });

  it('reads the cookie when the header is absent — the WebSocket handshake case', async () => {
    const { sso } = makeSso({ cookie: 'CF_Authorization' });
    const res = await sso.identify(request({ cookie: `other=1; CF_Authorization=${assertion()}` }));
    expect(res.ok).toBe(true);
  });

  it('ignores the cookie when none is configured', async () => {
    const { sso } = makeSso();
    expect(await sso.identify(request({ cookie: `CF_Authorization=${assertion()}` }))).toEqual({
      ok: false,
      reason: 'no-assertion',
    });
  });

  it('takes aud as an array, which is the shape Cloudflare Access signs', async () => {
    const { sso } = makeSso();
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion({ aud: ['other', 'app-aud-tag'] }) }));
    expect(res.ok).toBe(true);
  });

  it('reads a different claim when the provider names people differently (Teleport username)', async () => {
    const { sso } = makeSso({ claim: 'username', allow: ['noir'] });
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion({ username: 'noir' }) }));
    expect(res).toEqual({ ok: true, who: 'noir' });
  });
});

describe('WebSso: the source allowlist', () => {
  it('refuses an address outside `from` without even looking at the assertion', async () => {
    const { sso, fetched } = makeSso();
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }, '192.168.0.185'));
    expect(res).toEqual({ ok: false, reason: 'source' });
    // The point of checking the source first: an unauthenticated peer cannot make this daemon
    // fetch anything, valid assertion or not.
    expect(fetched()).toBe(0);
  });

  it('matches an IPv4-mapped address against an IPv4 subnet (a dual-stack listener gives these)', async () => {
    const { sso } = makeSso();
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }, '::ffff:10.0.0.2'));
    expect(res.ok).toBe(true);
  });

  it('refuses a connection whose address Node could not report', async () => {
    const { sso } = makeSso();
    const req = { headers: {}, socket: {} } as unknown as IncomingMessage;
    expect(await sso.identify(req)).toEqual({ ok: false, reason: 'source' });
  });

  it('accepts a bare address in `from` as one host', async () => {
    const { sso } = makeSso({ from: ['10.9.9.9'] });
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }, '10.9.9.9'))).ok).toBe(true);
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }, '10.9.9.8'))).toEqual({
      ok: false,
      reason: 'source',
    });
  });

  it('throws at construction on a CIDR that is not one, rather than silently trusting nothing', () => {
    expect(() => makeSso({ from: ['not-an-address/24'] })).toThrow();
  });

  it('throws on a trailing slash instead of reading it as /0 — the one typo that would fail OPEN', async () => {
    // `Number('')` is 0, and a /0 rule matches every address there is. Everything else
    // malformed here throws; this one would have quietly turned the allowlist off while the
    // startup log still printed it as one host.
    expect(() => makeSso({ from: ['203.0.113.7/'] })).toThrow(/prefix/);
    expect(() => makeSso({ from: ['203.0.113.7/0x8'] })).toThrow(/prefix/);
    expect(() => makeSso({ from: ['203.0.113.7/ 8'] })).toThrow(/prefix/);
    expect(() => makeSso({ from: ['203.0.113.7/33'] })).toThrow(/prefix/);
    // And the legitimate shapes still work.
    const { sso } = makeSso({ from: ['203.0.113.0/24', '10.0.0.0/8'] });
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }, '203.0.113.9'))).ok).toBe(true);
  });
});

describe('WebSso: forgery', () => {
  it('refuses alg: none — the oldest way to talk a verifier out of verifying', async () => {
    const { sso } = makeSso();
    const head = b64({ alg: 'none', kid: 'k1' });
    const body = b64({ iss: 'https://idp.example', aud: 'app-aud-tag', email: 'operator@example.com', exp: 9e9 });
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': `${head}.${body}.` }))).toEqual({
      ok: false,
      reason: 'alg',
    });
  });

  it('refuses HS256 signed with the public key as the secret — the other classic', async () => {
    const { sso } = makeSso();
    const head = b64({ alg: 'HS256', kid: 'k1' });
    const body = b64({ iss: 'https://idp.example', aud: 'app-aud-tag', email: 'operator@example.com', exp: 9e9 });
    const pem = provider.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const sig = createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': `${head}.${body}.${sig}` }))).toEqual({
      ok: false,
      reason: 'alg',
    });
  });

  it('refuses a token signed by some other key', async () => {
    const { sso } = makeSso();
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion({}, { key: otherKey.privateKey }) }));
    expect(res).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const { sso } = makeSso();
    const [head, , sig] = assertion().split('.') as [string, string, string];
    const tampered = `${head}.${b64({ iss: 'https://idp.example', aud: 'app-aud-tag', email: 'operator@example.com', exp: 9e9 })}.${sig}`;
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': tampered }))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuses anything that is not three base64url segments of JSON', async () => {
    const { sso } = makeSso();
    for (const junk of ['', 'a.b', 'a.b.c.d', 'not.a.jwt', `${b64('a string')}.${b64({})}.x`]) {
      const res = await sso.identify(request({ 'cf-access-jwt-assertion': junk }));
      expect(res.ok, junk).toBe(false);
    }
  });
});

describe('WebSso: claims', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an expired token', { exp: Math.floor(NOW / 1000) - 120 }, 'expired'],
    ['a token with no exp at all', { exp: undefined }, 'expired'],
    ['a token not valid yet', { nbf: Math.floor(NOW / 1000) + 120 }, 'not-yet-valid'],
    ['another issuer', { iss: 'https://evil.example' }, 'issuer'],
    ['another application of the same issuer', { aud: 'some-other-app' }, 'audience'],
    ['aud absent entirely', { aud: undefined }, 'audience'],
    ['someone not on the allowlist', { email: 'stranger@example.com' }, 'claim'],
    ['a claim that is not a string', { email: 42 }, 'claim'],
    ['the claim missing', { email: undefined }, 'claim'],
  ];
  for (const [what, claims, reason] of cases) {
    it(`refuses ${what}`, async () => {
      const { sso } = makeSso();
      expect(await sso.identify(request({ 'cf-access-jwt-assertion': assertion(claims) }))).toEqual({ ok: false, reason });
    });
  }

  it('tolerates a minute of clock skew in both directions', async () => {
    const { sso } = makeSso();
    const nearlyExpired = assertion({ exp: Math.floor(NOW / 1000) - 30 });
    const nearlyValid = assertion({ nbf: Math.floor(NOW / 1000) + 30 });
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': nearlyExpired }))).ok).toBe(true);
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': nearlyValid }))).ok).toBe(true);
  });
});

describe('WebSso: the key set', () => {
  it('fetches once and reuses the keys for later requests', async () => {
    const { sso, fetched } = makeSso();
    await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }));
    await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }));
    expect(fetched()).toBe(1);
  });

  it('shares one fetch across a burst rather than stampeding the provider', async () => {
    const { sso, fetched } = makeSso();
    await Promise.all([1, 2, 3, 4].map(() => sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))));
    expect(fetched()).toBe(1);
  });

  it('refetches for an unknown kid — a rotation — then honours the new key', async () => {
    let kid = 'k1';
    let now = NOW;
    const { sso, fetched } = makeSso({ now: () => now }, () => jwksFor(kid));
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).ok).toBe(true);
    kid = 'k2';
    // Past the cooldown the first fetch started: within it a rotation is refused, which is the
    // documented price of not letting a stranger drive this daemon's outbound requests.
    now += 15_000;
    const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion({}, { kid: 'k2' }) }));
    expect(res.ok).toBe(true);
    expect(fetched()).toBe(2);
  });

  it('does not refetch again within the cooldown, so junk kids cannot drive the fetch rate', async () => {
    let now = NOW;
    const { sso, fetched } = makeSso({ now: () => now });
    await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }));
    for (const kid of ['x1', 'x2', 'x3']) {
      const res = await sso.identify(request({ 'cf-access-jwt-assertion': assertion({}, { kid }) }));
      expect(res).toEqual({ ok: false, reason: 'unknown-key' });
    }
    expect(fetched()).toBe(1);
    now += 15_000;
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion({}, { kid: 'x4' }) }))).ok).toBe(false);
    expect(fetched()).toBe(2);
  });

  it('says so when the provider cannot be reached and no keys are held yet', async () => {
    const { sso, fail } = makeSso();
    fail(true);
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).toEqual({
      ok: false,
      reason: 'jwks-unavailable',
    });
  });

  it('keeps working on the keys it already has when the provider goes away', async () => {
    let now = NOW;
    const { sso, fail } = makeSso({ now: () => now });
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).ok).toBe(true);
    fail(true);
    // Past the refetch cooldown, so the next unknown-kid request really does try the provider
    // and really does fail — and the known key must survive that.
    now += 120_000;
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': assertion({}, { kid: 'gone' }) }))).toEqual({
      ok: false,
      reason: 'unknown-key',
    });
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).ok).toBe(true);
  });

  it('ignores JWKS entries it cannot verify with, without discarding the ones it can', async () => {
    const good = JSON.parse(jwksFor('k1')) as { keys: unknown[] };
    const mixed = JSON.stringify({
      keys: [{ kty: 'EC', kid: 'ec1', crv: 'P-256' }, { kty: 'RSA', kid: 'broken', n: '!!', e: 'AQAB' }, ...good.keys],
    });
    const { sso } = makeSso({}, () => mixed);
    expect((await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).ok).toBe(true);
  });

  it('refuses a JWKS document that is not one, rather than accepting a key set of nothing', async () => {
    const { sso } = makeSso({}, () => '<html>login page</html>');
    expect(await sso.identify(request({ 'cf-access-jwt-assertion': assertion() }))).toEqual({
      ok: false,
      reason: 'jwks-unavailable',
    });
  });
});
