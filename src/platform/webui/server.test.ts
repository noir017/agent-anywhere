import net from 'node:net';
import { afterEach, describe, it, expect } from 'vitest';

import { WebuiConfigSchema } from '../config-schemas.js';
import { WebAuth } from './auth.js';
import { WebRoom, type WebuiInstance } from './room.js';
import { createWebServer, type WebServer } from './server.js';

/**
 * These run a real server on a real (ephemeral, loopback) port.
 *
 * Worth the loop rather than asserting against a fake `req`/`res`: what is being checked here
 * is header behaviour, status codes and — above all — that shutdown terminates, and every one
 * of those is a property of `node:http` rather than of the handler this file could mock.
 */
const running: WebServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
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
  const room = new WebRoom(instance);
  const server = createWebServer(room, new WebAuth({ token: instance.token }), instance);
  await server.start();
  running.push(server);
  return { room, server, base: `http://127.0.0.1:${instance.port}`, instance };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function signIn(base: string, token = 'open-sesame'): Promise<string> {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ token }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0] ?? '';
}

describe('webui server: the page', () => {
  it('serves the page without a session, since the page is how you get one', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>Chat</title>');
    // Nothing is fetched from anywhere: no CDN, no font service, no analytics.
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('escapes the configured title instead of letting config.yaml write markup', async () => {
    const { base } = await boot({ title: '</title><script>alert(1)</script>' });
    const html = await fetch(`${base}/`).then((r) => r.text());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;');
  });

  it('answers an unknown route with a 404 rather than the page', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    expect((await fetch(`${base}/nope`, { headers: { cookie } })).status).toBe(404);
  });
});

describe('webui server: the door', () => {
  it('refuses every guarded route without a session', async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const send = await fetch(`${base}/api/send`, { method: 'POST', headers: JSON_HEADERS, body: '{"text":"x"}' });
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
    // No Secure over plain http, or the browser would drop the cookie and login would appear
    // to succeed while nothing worked.
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
    // A form post or an <img> can only produce a "simple" request, and a simple request cannot
    // carry application/json without a preflight the browser will not get an answer to.
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: '{"text":"x"}',
    });
    expect(res.status).toBe(415);
  });

  it('rejects a state-changing request that came from another origin', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed body with the offending field named', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ text: 'x', admin: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('admin');
  });
});

describe('webui server: traffic', () => {
  it('delivers a posted message to the room and streams the room to a client', async () => {
    const { base, room } = await boot();
    const cookie = await signIn(base);
    const heard: string[] = [];
    room.onMessage((m) => heard.push(m.content));

    const stream = await fetch(`${base}/api/events`, { headers: { cookie } });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    // Both of these tell a proxy not to buffer. nginx buffers SSE by default, and a buffered
    // stream shows nothing until the turn ends — indistinguishable from a hung daemon.
    expect(stream.headers.get('cache-control')).toContain('no-transform');
    expect(stream.headers.get('x-accel-buffering')).toBe('no');

    const reader = stream.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"t":"sync"');

    const sent = await fetch(`${base}/api/send`, { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ text: 'hi there' }) });
    expect(sent.status).toBe(202);
    expect(heard).toEqual(['hi there']);
    await reader?.cancel();
  });

  it('refuses a click on a message the room no longer holds', async () => {
    const { base } = await boot();
    const cookie = await signIn(base);
    const res = await fetch(`${base}/api/click`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie },
      body: JSON.stringify({ messageId: 'gone', buttonId: 'ask:r:0' }),
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
    expect(await res.text()).toContain('webui server: traffic');
  });

  it.each([
    ['an unknown token', 'f/deadbeef'],
    ['a path instead of a token', 'f/..%2F..%2Fetc%2Fpasswd'],
  ])('answers 404 for %s', async (_label, path) => {
    const { base } = await boot();
    const cookie = await signIn(base);
    expect((await fetch(`${base}/${path}`, { headers: { cookie } })).status).toBe(404);
  });
});

describe('webui server: lifecycle', () => {
  it('reports a port it cannot bind instead of letting the daemon run on half-working', async () => {
    // Without this, EADDRINUSE arrives as an asynchronous 'error' event, gets swallowed by the
    // daemon's global [uncaughtException] handler, and the daemon runs forever with a dead UI.
    const { instance } = await boot();
    const clash = createWebServer(new WebRoom(instance), new WebAuth({ token: 'x' }), instance);
    await expect(clash.start()).rejects.toThrow(/cannot bind/);
  });

  it('stops promptly with an event stream still open', async () => {
    // The regression this exists for: `server.close()` alone waits for every connection to
    // end, and an SSE response never does. Its callback would never fire, `Daemon.stop()`
    // would never resolve, and the signal handler's `process.exit` sits in that promise's
    // finally — so Ctrl-C would hang the daemon forever.
    const { base, server } = await boot();
    const cookie = await signIn(base);
    const stream = await fetch(`${base}/api/events`, { headers: { cookie } });
    const reader = stream.body?.getReader();
    await reader?.read(); // the sync frame; the connection now stays open by design

    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(1500);
    await reader?.cancel().catch(() => undefined);
  });
});
