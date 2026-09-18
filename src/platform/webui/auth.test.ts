import { describe, it, expect } from 'vitest';

import { WebAuth, readCookie, sessionCookie, SESSION_COOKIE } from './auth.js';

/** A WebAuth on a clock the test drives, so expiry and throttling need no real waiting. */
function makeAuth(token = 'correct-horse'): { auth: WebAuth; advance: (ms: number) => void } {
  let now = 1_000_000;
  const auth = new WebAuth({ token, now: () => now });
  return { auth, advance: (ms) => { now += ms; } };
}

const cookieOf = (sessionId: string): string => `${SESSION_COOKIE}=${sessionId}`;

describe('WebAuth: the shared secret', () => {
  it('accepts the configured secret and issues a session the cookie check then honours', () => {
    const { auth } = makeAuth();
    const res = auth.login('correct-horse', '1.2.3.4');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(auth.check(cookieOf(res.sessionId))).toBe(true);
  });

  it('rejects a wrong secret, and one of a different length (the constant-time path)', () => {
    const { auth } = makeAuth();
    expect(auth.login('wrong-horse!!', '1.2.3.4')).toEqual({ ok: false, reason: 'bad-token' });
    expect(auth.login('short', '1.2.3.4')).toEqual({ ok: false, reason: 'bad-token' });
  });

  it('issues a distinct session per login', () => {
    const { auth } = makeAuth();
    const a = auth.login('correct-horse', 'x');
    const b = auth.login('correct-horse', 'x');
    expect(a.ok && b.ok && a.sessionId !== b.sessionId).toBe(true);
  });

  it('refuses an unknown or absent cookie', () => {
    const { auth } = makeAuth();
    expect(auth.check(undefined)).toBe(false);
    expect(auth.check(cookieOf('not-a-session'))).toBe(false);
    expect(auth.check('other=1')).toBe(false);
  });

  it('revokes a session', () => {
    const { auth } = makeAuth();
    const res = auth.login('correct-horse', 'x');
    if (!res.ok) throw new Error('login failed');
    auth.revoke(cookieOf(res.sessionId));
    expect(auth.check(cookieOf(res.sessionId))).toBe(false);
  });
});

describe('WebAuth: session lifetime', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it('expires a session left unused for the full TTL', () => {
    const { auth, advance } = makeAuth();
    const res = auth.login('correct-horse', 'x');
    if (!res.ok) throw new Error('login failed');
    advance(WEEK + 1);
    expect(auth.check(cookieOf(res.sessionId))).toBe(false);
  });

  it('keeps an open tab alive: every check refreshes the expiry', () => {
    const { auth, advance } = makeAuth();
    const res = auth.login('correct-horse', 'x');
    if (!res.ok) throw new Error('login failed');
    for (let i = 0; i < 10; i += 1) {
      advance(WEEK - 1000);
      expect(auth.check(cookieOf(res.sessionId))).toBe(true);
    }
  });

  it('evicts the least recently used session past the cap instead of growing', () => {
    const { auth } = makeAuth();
    const first = auth.login('correct-horse', 'x');
    if (!first.ok) throw new Error('login failed');
    for (let i = 0; i < 64; i += 1) auth.login('correct-horse', 'x');
    expect(auth.check(cookieOf(first.sessionId))).toBe(false);
  });
});

/**
 * The throttle is what stands between a secret an operator typed by hand and a network that
 * can try it a few thousand times a second. These assertions pin the shape of that, not just
 * that some limit exists.
 */
describe('WebAuth: brute-force throttle', () => {
  const spam = (auth: WebAuth, n: number, from = '1.2.3.4'): ReturnType<WebAuth['login']> => {
    let last = auth.login('nope---------', from);
    for (let i = 1; i < n; i += 1) last = auth.login('nope---------', from);
    return last;
  };

  it('allows five guesses in a minute and blocks the sixth', () => {
    const { auth } = makeAuth();
    // The fifth guess is the one that arms the block, so it is still answered as a plain
    // wrong secret; the sixth is the first one refused without being checked.
    expect(spam(auth, 5)).toEqual({ ok: false, reason: 'bad-token' });
    expect(auth.login('nope---------', '1.2.3.4')).toEqual({
      ok: false,
      reason: 'throttled',
      retryAfterSec: 60,
    });
  });

  it('refuses even the CORRECT secret while a source is locked out', () => {
    const { auth } = makeAuth();
    spam(auth, 5);
    expect(auth.login('correct-horse', '1.2.3.4')).toMatchObject({ ok: false, reason: 'throttled' });
  });

  it('locks out one source without touching another', () => {
    const { auth } = makeAuth();
    spam(auth, 5, '1.2.3.4');
    expect(auth.login('correct-horse', '5.6.7.8')).toMatchObject({ ok: true });
  });

  it('lets the source back in once the block expires', () => {
    const { auth, advance } = makeAuth();
    spam(auth, 5);
    advance(60_001);
    expect(auth.login('correct-horse', '1.2.3.4')).toMatchObject({ ok: true });
  });

  it('does not accumulate typos across a quiet gap into a lockout', () => {
    const { auth, advance } = makeAuth();
    for (let round = 0; round < 4; round += 1) {
      spam(auth, 4);
      advance(60_001);
    }
    expect(auth.login('correct-horse', '1.2.3.4')).toMatchObject({ ok: true });
  });

  it('clears the failure count on a successful login', () => {
    const { auth } = makeAuth();
    spam(auth, 4);
    expect(auth.login('correct-horse', '1.2.3.4')).toMatchObject({ ok: true });
    expect(spam(auth, 4)).toMatchObject({ ok: false, reason: 'bad-token' });
  });
});

describe('cookie helpers', () => {
  it.each([
    ['aa_webui=abc', 'abc'],
    ['x=1; aa_webui=abc; y=2', 'abc'],
    ['  aa_webui = abc  ', 'abc'],
    ['aa_webui=', undefined],
    ['aa_webui_other=abc', undefined],
    ['nonsense', undefined],
    [undefined, undefined],
  ])('readCookie(%s)', (header, want) => {
    expect(readCookie(header, SESSION_COOKIE)).toBe(want);
  });

  it('sets HttpOnly and SameSite=Strict always, Secure only over TLS', () => {
    const plain = sessionCookie('sid', false);
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('SameSite=Strict');
    expect(plain).not.toContain('Secure');
    expect(sessionCookie('sid', true)).toContain('Secure');
  });
});
