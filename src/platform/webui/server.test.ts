import fs from 'node:fs';
import { createSign, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { WebuiConfigSchema } from '../config-schemas.js';
import { WebAuth } from './auth.js';
import { WebRoom, type WebuiInstance } from './room.js';
import { createWebServer, type WebServer } from './server.js';
import { WebSso, type SsoOptions } from './sso.js';
import { TerminalSessions } from './terminal-sessions.js';
import { TopicStore } from './topics.js';

/**
 * These run a real server on a real (ephemeral, loopback) port.
 *
 * Worth the loop rather than asserting against a fake `req`/`res`: what is checked here is
 * header behaviour, status codes, that a compressed stream actually delivers events one at a
 * time, and that shutdown terminates — every one of which is a property of `node:http` and
 * `node:zlib` rather than of the handler a mock could stand in for.
 */
const running: WebServer[] = [];
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-server-'));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Booted {
  room: WebRoom;
  server: WebServer;
  base: string;
  port: number;
  topic: string;
  instance: WebuiInstance;
  sessions: TerminalSessions;
}

async function boot(
  over: Partial<WebuiInstance> = {},
  terminal: { enabled: boolean; socket: string; endCommand?: string[] } = {
    enabled: false,
    socket: '/nonexistent.sock',
  },
  sso?: WebSso
): Promise<Booted> {
  const port = await freePort();
  const instance: WebuiInstance = {
    ...WebuiConfigSchema.parse({ type: 'webui', token: 'open-sesame' }),
    id: 'webui',
    host: '127.0.0.1',
    port,
    ...over,
  };
  const topics = new TopicStore(path.join(dir, `${port}.json`));
  const topic = topics.current().id;
  const room = new WebRoom(instance, topics);
  const sessions = new TerminalSessions(terminal.endCommand);
  room.useTerminalSessions(sessions);
  const server = createWebServer(
    room,
    new WebAuth({ token: instance.token }),
    instance,
    { enabled: terminal.enabled, socket: terminal.socket, sessions },
    sso
  );
  await server.start();
  running.push(server);
  return { room, server, base: `http://127.0.0.1:${port}`, port, topic, instance, sessions };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Spin until something becomes true, or give up loudly.
 *
 * For facts that land on a socket event rather than in the response: a peer's close reaches
 * this process some turns after the client destroyed its end, and how many is `node:net`'s
 * business. A fixed sleep here would be a test that passes until the machine is busy.
 */
async function until(ok: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never happened: ${what}`);
}

async function signIn(base: string, token = 'open-sesame'): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** Open an event stream with raw `node:http`, so compression is visible instead of undone. */
function openStream(
  port: number,
  topic: string,
  cookie: string,
  lastEventId?: string
): Promise<{ res: http.IncomingMessage; next: () => Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/events?t=${topic}`,
        headers: {
          cookie,
          'accept-encoding': 'gzip',
          ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        },
      },
      (res) => {
        const out = res.headers['content-encoding'] === 'gzip' ? res.pipe(createGunzip()) : res;
        const pending: string[] = [];
        let waiting: ((chunk: string) => void) | null = null;
        out.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (waiting) {
            const fn = waiting;
            waiting = null;
            fn(text);
          } else pending.push(text);
        });
        resolve({
          res,
          next: () =>
            new Promise<string>((done) => {
              const ready = pending.shift();
              if (ready !== undefined) done(ready);
              else waiting = done;
            }),
          close: () => req.destroy(),
        });
      }
    );
    req.once('error', reject);
    req.end();
  });
}

describe('webui server: the page', () => {
  it('serves the page without a session, since the page is how you get one', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>Chat</title>');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('escapes the configured title instead of letting config.yaml write markup', async () => {
    const { base } = await boot({ title: '</title><script>alert(1)</script>' });
    const html = await fetch(`${base}/`).then((r) => r.text());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;');
  });

  it('compresses it, because the page is the largest thing on the wire', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/`, { headers: { 'accept-encoding': 'gzip' } });
    // undici decodes and drops the header, so the reliable witness is Vary — set only on the
    // branch that actually compressed.
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
  });
});

describe('webui server: installing it as an app', () => {
  it('serves the manifest and both icons without a session', async () => {
    // The browser fetches all three while deciding whether the site can be installed, which is
    // before anyone has signed in. A 401 here reads as "not installable", with no error to see.
    const { base } = await boot();

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');

    const svg = await fetch(`${base}/icon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');

    const png = await fetch(`${base}/icon.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    // The PNG signature. Proves the base64 in manifest.ts survived whatever edited it, which
    // is the one way these bytes can rot without anything else noticing.
    const bytes = Buffer.from(await png.arrayBuffer());
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([192, 192]);
  });

  it('names the app after the configured title', async () => {
    const { base } = await boot({ title: 'Ops box' });
    const m = await fetch(`${base}/manifest.webmanifest`).then((r) => r.json());
    expect(m.name).toBe('Ops box');
    expect(m.short_name).toBe('Ops box');
    expect(m.display).toBe('standalone');
  });

  it('keeps every manifest URL relative, so a sub-path mount still resolves', async () => {
    // Same rule the page follows for api/events. An absolute "/" would walk out of a prefix a
    // reverse proxy put the daemon under, and the installed app would open on the proxy's root.
    const { base } = await boot();
    const m = await fetch(`${base}/manifest.webmanifest`).then((r) => r.json());
    for (const url of [m.start_url, m.scope, ...m.icons.map((i: { src: string }) => i.src)]) {
      expect(url.startsWith('/')).toBe(false);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  it('lets the page reach its own manifest and icons through the CSP', async () => {
    // default-src is 'none', and manifest-src/img-src both fall back to it — so without these
    // two the browser blocks the very files that make the site installable, and the only
    // symptom is a console warning nobody is watching on a phone.
    const { base } = await boot();
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
  });
});

describe('webui server: the door', () => {
  it('refuses every guarded route without a session', async () => {
    const { base, topic } = await boot();
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const send = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ topic, text: 'x' }),
    });
    expect(send.status).toBe(401);
  });

  it('refuses the wrong token and accepts the right one', async () => {
    const { base } = await boot();
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();

    const good = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'open-sesame' }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // No Secure over plain http, or the browser drops the cookie and login appears to succeed
    // while nothing works.
    expect(cookie).not.toContain('Secure');
  });

  it('throttles a run of guesses with a 429 and a Retry-After', async () => {
    const { base } = await boot();
    let last = new Response();
    for (let i = 0; i < 6; i += 1) {
      last = await fetch(`${base}/api/login`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token: 'nope' }) });
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('retry-after')).toBe('60');
  });

  it('rejects a body that is not JSON, which is half of the CSRF defence', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: JSON.stringify({ topic, text: 'x' }),
    });
    expect(res.status).toBe(415);
  });

  it('rejects a state-changing request that came from another origin', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ topic, text: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ['an unknown key', { topic: 'aaaaaaaa', text: 'x', admin: true }],
    ['a malformed topic id', { topic: 'not-a-topic', text: 'x' }],
    ['no topic at all', { text: 'x' }],
  ])('rejects %s', async (_label, body) => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * A `WebSso` whose provider is in this file: one keypair, a JWKS served by an injected fetch,
 * and tokens signed on demand. Nothing here opens a socket to the outside.
 */
const provider = generateKeyPairSync('rsa', { modulusLength: 2048 });

function ssoFor(over: Partial<SsoOptions> = {}): { sso: WebSso; token: (claims?: Record<string, unknown>) => string } {
  const jwks = JSON.stringify({
    keys: [{ ...provider.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
  });
  const sso = new WebSso({
    header: 'Cf-Access-Jwt-Assertion',
    cookie: 'CF_Authorization',
    jwksUrl: 'https://idp.example/certs',
    issuer: 'https://idp.example',
    audience: 'aud-tag',
    claim: 'email',
    allow: ['operator@example.com'],
    from: ['127.0.0.1'],
    fetch: (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => jwks }) as Response) as unknown as typeof globalThis.fetch,
    ...over,
  });
  const token = (claims: Record<string, unknown> = {}): string => {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const head = b64({ alg: 'RS256', kid: 'k1' });
    const body = b64({
      iss: 'https://idp.example',
      aud: 'aud-tag',
      email: 'operator@example.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    });
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(provider.privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  return { sso, token };
}

describe('webui server: the other door', () => {
  it('admits a request carrying the proxy assertion, with no session cookie at all', async () => {
    const { sso, token } = ssoFor();
    const { base, topic } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'cf-access-jwt-assertion': token() },
      body: JSON.stringify({ text: 'hello', topic }),
    });
    expect(res.status).toBe(202);
  });

  it('still refuses one the proxy did not sign', async () => {
    const { sso } = ssoFor();
    const { base } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/events`, { headers: { 'cf-access-jwt-assertion': 'nope.nope.nope' } });
    expect(res.status).toBe(401);
  });

  it('refuses one for somebody else, even correctly signed', async () => {
    const { sso, token } = ssoFor();
    const { base } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/events`, {
      headers: { 'cf-access-jwt-assertion': token({ email: 'stranger@example.com' }) },
    });
    expect(res.status).toBe(401);
  });

  it('refuses it when the request did not come from the proxy `from` names', async () => {
    // 10.0.0.0/8 cannot be this loopback connection, which is the point: the assertion is
    // perfect and the request is still turned away.
    const { sso, token } = ssoFor({ from: ['10.0.0.0/8'] });
    const { base } = await boot({}, undefined, sso);
    const res = await fetch(`${base}/api/events`, { headers: { 'cf-access-jwt-assertion': token() } });
    expect(res.status).toBe(401);
  });

  it('admits the terminal handshake too — the gate an upgrade bypasses', async () => {
    const socket = path.join(dir, 'sso-term.sock');
    const ttyd = await fakeTtyd(socket);
    const { sso, token } = ssoFor();
    const { port, topic, base } = await boot({}, { enabled: true, socket }, sso);
    // Through the cookie, because that is the form the assertion takes on a handshake the proxy
    // does not add headers to.
    const res = await handshake(port, `/term/ws?arg=${topic}`, {
      cookie: `CF_Authorization=${token()}`,
      origin: base,
    });
    expect(res.status).toBe(101);
    await ttyd.close();
  });

  it('refuses a handshake with neither cookie nor header', async () => {
    const socket = path.join(dir, 'sso-term-2.sock');
    const ttyd = await fakeTtyd(socket);
    const { sso } = ssoFor();
    const { port, topic, base } = await boot({}, { enabled: true, socket }, sso);
    const res = await handshake(port, `/term/ws?arg=${topic}`, { origin: base });
    expect(res.status).not.toBe(101);
    expect(ttyd.seen).toHaveLength(0);
    await ttyd.close();
  });

  it('closes the password door when told to, and serves a page with no field in it', async () => {
    const { sso: ssoConfig } = WebuiConfigSchema.parse({
      type: 'webui',
      token: 'open-sesame',
      sso: {
        jwksUrl: 'https://idp.example/certs',
        issuer: 'https://idp.example',
        audience: 'aud-tag',
        allow: ['operator@example.com'],
        from: ['127.0.0.1'],
        password: false,
      },
    });
    const { sso, token } = ssoFor();
    const { base, topic } = await boot({ sso: ssoConfig }, undefined, sso);
    const refused = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: 'open-sesame' }),
    });
    expect(refused.status).toBe(403);
    expect(await (await fetch(base)).text()).not.toContain('id="secret"');
    // And the other door still opens.
    const ok = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'cf-access-jwt-assertion': token() },
      body: JSON.stringify({ text: 'hi', topic }),
    });
    expect(ok.status).toBe(202);
  });

  it('leaves the password door open by default when sso is configured', async () => {
    const { sso } = ssoFor();
    const { base } = await boot({}, undefined, sso);
    expect(await signIn(base)).toContain('aa_webui=');
    expect(await (await fetch(base)).text()).toContain('id="secret"');
  });

  it('answers whether a topic exists only to someone already admitted', async () => {
    // Moving the arg check ahead of admission (it is cheap, and the gate is now async) would
    // have turned "400 vs 401" into an existence oracle for topic ids a stranger could walk.
    const socket = path.join(dir, 'sso-term-3.sock');
    const ttyd = await fakeTtyd(socket);
    const { sso } = ssoFor();
    const { port, topic, base } = await boot({}, { enabled: true, socket }, sso);
    const real = await handshake(port, `/term/ws?arg=${topic}`, { origin: base });
    const fake = await handshake(port, '/term/ws?arg=00000000', { origin: base });
    expect(real.status).toBe(fake.status);
    expect(real.status).not.toBe(101);
    await ttyd.close();
  });

});

describe('webui server: topics', () => {
  it('opens one and reports it', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/topics`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { topic: { id: string } };
    expect(made.topic.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('streams only the topic that was asked for', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const other = room.createTopic('other').id;
    const stream = await openStream(port, topic, cookie);
    await stream.next(); // the sync frame

    room.post(other, { own: false, html: '<p>elsewhere</p>' }, 'elsewhere');
    room.post(topic, { own: false, html: '<p>here</p>' }, 'here');
    // Read up to the message, since the cross-topic `topics` broadcast rides the same wire.
    let seen = '';
    for (let i = 0; i < 6 && !seen.includes('here'); i += 1) seen += await stream.next();
    // The other topic's message must not be on this wire at all — that isolation is what keeps
    // one busy room from costing a client reading a quiet one.
    expect(seen).not.toContain('elsewhere');
    expect(seen).toContain('here');
    stream.close();
  });

  it('answers 404 for a message sent to a topic that does not exist', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: 'deadbeef', text: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes an existing topic and rejects unknown ones', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const created = room.createTopic('deleteme').id;

    // POST /api/topics/delete
    const res = await fetch(`${base}/api/topics/delete`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: created }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(room.topics.has(created)).toBe(false);

    // Deleting again answers 404
    const res404 = await fetch(`${base}/api/topics/delete`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: created }),
    });
    expect(res404.status).toBe(404);

    // Also supports DELETE /api/topics
    const another = room.createTopic('another').id;
    const resDel = await fetch(`${base}/api/topics`, {
      method: 'DELETE',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic: another }),
    });
    expect(resDel.status).toBe(200);
    expect(room.topics.has(another)).toBe(false);
  });

  it('clears every topic and answers with the one that replaced them', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    room.createTopic('second');
    room.createTopic('third');

    const res = await fetch(`${base}/api/topics/clear`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: '{}',
    });

    expect(res.status).toBe(200);
    const { topic: fresh } = (await res.json()) as { topic: { id: string } };
    // The replacement comes back in the RESPONSE: the page has its own per-topic caches to drop
    // and then has to land somewhere, and racing a POST against an SSE frame to find out where
    // is a worse contract than being told.
    expect(fresh.id).toMatch(/^[0-9a-f]{8}$/);
    expect(room.topics.list().map((t) => t.id)).toEqual([fresh.id]);
    expect(room.topics.has(topic)).toBe(false);
  });
});

describe('webui server: built for a weak link', () => {
  it('compresses the event stream AND still delivers each event as it happens', async () => {
    // The trap this pins: a gzip stream buffers until told otherwise, so without an explicit
    // Z_SYNC_FLUSH after every event the page receives nothing until the connection closes —
    // a "live" UI that shows the whole turn at the end of it. Without the flush this test does
    // not fail an assertion, it hangs, which is the honest reproduction of the bug.
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const stream = await openStream(port, topic, cookie);
    expect(stream.res.headers['content-encoding']).toBe('gzip');
    expect(await stream.next()).toContain('"t":"sync"');

    room.post(topic, { own: false, html: '<p>later</p>' }, 'later');
    expect(await stream.next()).toContain('later');
    stream.close();
  });

  it('resumes from where a dropped stream left off instead of re-sending everything', async () => {
    const { base, port, room, topic } = await boot();
    const cookie = await signIn(base);
    const first = await openStream(port, topic, cookie);
    await first.next();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const frame = await first.next();
    const id = /id: (\S+)/.exec(frame)?.[1] ?? '';
    expect(id).toMatch(new RegExp(`^${topic}\\.\\d+$`));
    first.close();

    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    const second = await openStream(port, topic, cookie, id);
    const resumed = await second.next();
    // Only what was missed. Re-sending the whole conversation after every blip was the single
    // most expensive thing this protocol did on a bad connection.
    expect(resumed).toContain('two');
    expect(resumed).not.toContain('"t":"sync"');
    expect(resumed).not.toContain('one');
    second.close();
  });

  it('delivers a retried send once', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const heard: string[] = [];
    room.onMessage((m) => heard.push(m.content));
    const body = JSON.stringify({ topic, text: 'only once', nonce: 'n-1' });
    const a = await fetch(`${base}/api/send`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body });
    const b = await fetch(`${base}/api/send`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body });
    // The retry is answered as if it were the original, because for the caller it is.
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(heard).toEqual(['only once']);
  });
});

describe('webui server: traffic', () => {
  it('delivers a posted message to the room', async () => {
    const { base, room, topic } = await boot();
    const cookie = await signIn(base);
    const heard: string[] = [];
    room.onMessage((m) => heard.push(m.content));
    const sent = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, text: 'hi there' }),
    });
    expect(sent.status).toBe(202);
    expect(heard).toEqual(['hi there']);
  });

  it('refuses a click on a message the room no longer holds', async () => {
    const { base, topic } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/click`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ topic, messageId: 'gone', buttonId: 'ask:r:0' }),
    });
    expect(res.status).toBe(409);
  });

  it('serves a published file as an attachment that can never execute on this origin', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    // An agent that sent an .html would otherwise get it rendered same-origin, holding this
    // session's cookie — so the type is always octet-stream and the disposition always
    // attachment, whatever the file actually is.
    const url = room.publish(new URL(import.meta.url).pathname, 'evil.html');
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves a raster image as itself, so the page can show it', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const url = room.publish(new URL(import.meta.url).pathname, 'shot.png');
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('inline');
    // The inline exception rests entirely on this: a file merely NAMED .png is pinned to the
    // type we declared, so a document cannot be sniffed back out of one.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });

  it.each([
    ['an .svg, which is XML a browser runs', 'diagram.svg'],
    ['a .pdf, which browsers render and which scripts', 'report.pdf'],
    ['an extensionless name', 'screenshot'],
    ['a name whose extension only looks like one', 'notes.png.html'],
  ])('keeps %s a download', async (_label, name) => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const url = room.publish(new URL(import.meta.url).pathname, name);
    const res = await fetch(`${base}/${url}`, { headers: { cookie } });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain('attachment');
  });

  it.each([
    ['an unknown token', 'f/deadbeef'],
    ['a path instead of a token', 'f/..%2F..%2Fetc%2Fpasswd'],
  ])('answers 404 for %s', async (_label, p) => {
    const { base } = await boot();
    const cookie = await signIn(base);
    expect((await fetch(`${base}/${p}`, { headers: { cookie } })).status).toBe(404);
  });
});

describe('webui server: lifecycle', () => {
  it('reports a port it cannot bind instead of letting the daemon run on half-working', async () => {
    // Without this, EADDRINUSE arrives as an asynchronous 'error' event, gets swallowed by the
    // daemon's global [uncaughtException] handler, and the daemon runs forever with a dead UI.
    const { instance } = await boot();
    const topics = new TopicStore(path.join(dir, 'clash.json'));
    const clash = createWebServer(new WebRoom(instance, topics), new WebAuth({ token: 'x' }), instance, {
      enabled: false,
      socket: '/nonexistent.sock',
      sessions: new TerminalSessions(),
    });
    await expect(clash.start()).rejects.toThrow(/cannot bind/);
  });

  it('stops promptly with a compressed event stream still open', async () => {
    // The regression this exists for: `server.close()` alone waits for every connection to
    // end, and an SSE response never does. Its callback would never fire, `Daemon.stop()` would
    // never resolve, and the signal handler's `process.exit` sits in that promise's finally —
    // so Ctrl-C would hang the daemon forever. The gzip stream has to be ended too, not just
    // the response.
    const { base, port, server, topic } = await boot();
    const cookie = await signIn(base);
    const stream = await openStream(port, topic, cookie);
    await stream.next();

    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    stream.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal proxy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in for ttyd on a unix socket: answers one GET and echoes bytes after an upgrade.
 *
 * Deliberately not a WebSocket library — the proxy under test never parses a frame, so a
 * handshake that looks right on the wire plus a byte echo is exactly the contract it has.
 */
function fakeTtyd(socketPath: string): Promise<{ seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/html', 'x-from': 'ttyd' });
    res.end('<html>terminal</html>');
  });
  server.on('upgrade', (req, socket) => {
    seen.push(req.url ?? '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: stand-in\r\nSec-WebSocket-Protocol: tty\r\n\r\n'
    );
    socket.on('data', (d: Buffer) => socket.write(d));
    // Hang up when the proxy does. An `http.Server` socket reports the proxy's FIN as `end`
    // and then sits half-open forever, so without this the stand-in's own `close()` never
    // returns and the test reads as a leak in the code under test. Real ttyd closes on FIN.
    socket.on('end', () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    );
  });
}

/** Attempt a WebSocket handshake against the daemon and report what came back. */
function handshake(
  port: number,
  path_: string,
  headers: Record<string, string>
): Promise<{ status: number; echo?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: path_,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'AQIDBAUGBwgJCgsMDQ4PEC==',
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.once('data', (d: Buffer) => {
        socket.destroy();
        resolve({ status: 101, echo: d.toString('utf8') });
      });
      socket.write('hello');
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    // A refusal that writes a status line and hangs up arrives here rather than as a parsed
    // response, because `socket.end()` closes before the client has a body to finish.
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNRESET') resolve({ status: 0 });
      else reject(e);
    });
    req.end();
    setTimeout(() => reject(new Error('handshake never settled')), 4000).unref();
  });
}

describe('webui server: terminal', () => {
  it('is not reachable at all when the feature is off', async () => {
    const { base, port } = await boot();
    const cookie = await signIn(base);
    expect((await fetch(`${base}/term/`, { headers: { cookie } })).status).toBe(404);
    // And neither is the handshake — which is the half that does NOT go through the route
    // table, so a 404 on the GET says nothing about it.
    const up = await handshake(port, '/term/ws', { cookie, origin: `http://127.0.0.1:${port}` });
    expect(up.status).not.toBe(101);
  });

  it('proxies the page and the websocket once signed in', async () => {
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);

    const page = await fetch(`${base}/term/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    // Passed through rather than rebuilt: ttyd's own headers have to survive, because its
    // Content-Encoding is how the browser knows to inflate the page.
    expect(page.headers.get('x-from')).toBe('ttyd');
    expect(await page.text()).toContain('terminal');

    const up = await handshake(port, '/term/ws', { cookie, origin: `http://127.0.0.1:${port}` });
    expect(up.status).toBe(101);
    expect(up.echo).toBe('hello');
    expect(ttyd.seen).toContain('/term/ws');
    await ttyd.close();
  });

  it('refuses a handshake with no session, rather than leaving it hanging', async () => {
    // The trap this pins: an upgrade never reaches `route()`, so none of the checks there
    // apply to it. A hung handshake would also be indistinguishable from a slow backend and
    // would hold a connection against the browser's per-origin limit for the tab's lifetime.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { port } = await boot({}, { enabled: true, socket: socketPath });
    const up = await handshake(port, '/term/ws', { origin: `http://127.0.0.1:${port}` });
    expect(up.status).not.toBe(101);
    expect(ttyd.seen).toHaveLength(0);
    await ttyd.close();
  });

  it('refuses a handshake from another origin, and one that names no origin', async () => {
    // A handshake is exempt from the same-origin policy and carries cookies whatever
    // `SameSite` says, so here the Origin check is the only lock rather than the second one.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);

    expect((await handshake(port, '/term/ws', { cookie, origin: 'http://evil.test' })).status).not.toBe(101);
    expect((await handshake(port, '/term/ws', { cookie })).status).not.toBe(101);
    expect(ttyd.seen).toHaveLength(0);
    await ttyd.close();
  });

  it('refuses an arg that is not one of this room’s topics', async () => {
    // ttyd runs with --url-arg, so this string reaches an exec on the other side. It is
    // checked against the topic store before ttyd ever sees it.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port, topic } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);

    expect((await fetch(`${base}/term/?arg=deadbeef`, { headers: { cookie } })).status).toBe(400);
    expect((await fetch(`${base}/term/?arg=${topic}`, { headers: { cookie } })).status).toBe(200);
    // Two args is nobody's legitimate request and would hand the wrapper a second parameter.
    expect((await fetch(`${base}/term/?arg=${topic}&arg=${topic}`, { headers: { cookie } })).status).toBe(400);

    const bad = await handshake(port, '/term/ws?arg=deadbeef', {
      cookie,
      origin: `http://127.0.0.1:${port}`,
    });
    expect(bad.status).not.toBe(101);
    await ttyd.close();
  });

  it('says so plainly when the backend is not running', async () => {
    const { base } = await boot({}, { enabled: true, socket: path.join(dir, 'absent.sock') });
    const cookie = await signIn(base);
    const res = await fetch(`${base}/term/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/not running/);
  });

  it('stops promptly with a proxied websocket still open', async () => {
    // Same shape as the event-stream case above, one hop further out: the connection to ttyd
    // is one `server.close()` would wait on forever and is not ours to wait for.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port, server } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);
    const live = await handshake(port, '/term/ws', { cookie, origin: `http://127.0.0.1:${port}` });
    expect(live.status).toBe(101);

    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    await ttyd.close();
  });

  it('counts a live pane against its topic, and stops counting when it goes', async () => {
    // What the switcher's marker is made of. The count is the daemon's only knowledge of the
    // terminal — it never asks the far side anything — so this is the whole of "running".
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { base, port, topic, sessions, room } = await boot({}, { enabled: true, socket: socketPath });
    const cookie = await signIn(base);
    expect(sessions.has(topic)).toBe(false);

    const up = await handshake(port, `/term/ws?arg=${topic}`, { cookie, origin: `http://127.0.0.1:${port}` });
    expect(up.status).toBe(101);
    expect(sessions.has(topic)).toBe(true);
    expect(room.topicList().find((t) => t.id === topic)?.term).toBe(true);

    // `handshake` destroys its socket after the echo, which is a closed tab. The count has to
    // follow it down or the marker never goes out again.
    await until(() => !sessions.has(topic));
    expect(room.topicList().find((t) => t.id === topic)?.term).toBe(false);
    await ttyd.close();
  });

  it('does not count a handshake it refused', async () => {
    // A refusal is not a pane. Counting one would light a marker with nothing left to put it
    // out, since there is no socket whose close could decrement it.
    const socketPath = path.join(dir, 'ttyd.sock');
    const ttyd = await fakeTtyd(socketPath);
    const { port, sessions } = await boot({}, { enabled: true, socket: socketPath });
    const bad = await handshake(port, '/term/ws?arg=deadbeef', { origin: `http://127.0.0.1:${port}` });
    expect(bad.status).not.toBe(101);
    expect(sessions.has('deadbeef')).toBe(false);
    await ttyd.close();
  });

  it('ends a session by running the command the operator configured', async () => {
    const stamp = path.join(dir, 'ended.txt');
    const { base, topic } = await boot(
      {},
      {
        enabled: true,
        socket: path.join(dir, 'absent.sock'),
        // No shell: argv[0] is the program, and `{topic}` is substituted into an argument
        // rather than into a command line. `node -e` rather than `sh -c` so this does not
        // depend on a shell being there.
        endCommand: [
          process.execPath,
          '-e',
          'require("fs").writeFileSync(process.argv[1], process.argv[2])',
          stamp,
          '{topic}',
        ],
      }
    );
    const cookie = await signIn(base);

    const res = await fetch(`${base}/api/terminal/end`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: base },
      body: JSON.stringify({ topic }),
    });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(stamp, 'utf8')).toBe(topic);
  });

  it('reports a command that failed instead of claiming the session is gone', async () => {
    const { base, topic } = await boot(
      {},
      {
        enabled: true,
        socket: path.join(dir, 'absent.sock'),
        endCommand: [process.execPath, '-e', 'process.exit(3)', '{topic}'],
      }
    );
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/terminal/end`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: base },
      body: JSON.stringify({ topic }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not end/);
  });

  it('refuses to end anything without a configured command, or for a topic it does not have', async () => {
    const { base, topic } = await boot({}, { enabled: true, socket: path.join(dir, 'absent.sock') });
    const cookie = await signIn(base);
    const end = (body: unknown): Promise<Response> =>
      fetch(`${base}/api/terminal/end`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, cookie, origin: base },
        body: JSON.stringify(body),
      });

    // Unknown topic first: it is answered before the missing command, so a page cannot learn
    // which topics exist by reading which error it gets.
    expect((await end({ topic: 'deadbeef' })).status).toBe(404);
    // 501, not 404: the route is there and the request was fine — this deployment simply never
    // said what ending a session means.
    expect((await end({ topic })).status).toBe(501);
    // And the shape is still a shape. `{topic}` reaches a command, so nothing else may.
    expect((await end({ topic, extra: 1 })).status).toBe(400);
    expect((await end({ topic: '../../etc' })).status).toBe(400);
  });

  it('will not end a session on a daemon that serves no terminal', async () => {
    const { base, topic } = await boot({}, { enabled: false, socket: '/nonexistent.sock', endCommand: ['true', '{topic}'] });
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/terminal/end`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: base },
      body: JSON.stringify({ topic }),
    });
    expect(res.status).toBe(404);
  });
});
