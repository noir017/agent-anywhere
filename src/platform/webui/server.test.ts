import fs from 'node:fs';
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
}

async function boot(over: Partial<WebuiInstance> = {}): Promise<Booted> {
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
  const server = createWebServer(room, new WebAuth({ token: instance.token }), instance);
  await server.start();
  running.push(server);
  return { room, server, base: `http://127.0.0.1:${port}`, port, topic, instance };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

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
    const clash = createWebServer(new WebRoom(instance, topics), new WebAuth({ token: 'x' }), instance);
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
