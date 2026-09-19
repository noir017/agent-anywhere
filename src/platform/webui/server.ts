/**
 * The HTTP surface of the web UI: the page, the event stream, and four small POSTs.
 *
 * Plain `node:http`, and plain server-sent events rather than a WebSocket. Node has no
 * WebSocket server of its own, so that choice would mean a new dependency for one local page —
 * while SSE needs nothing on either side (`EventSource` is built into every browser, reconnects
 * by itself, and hands back the last id it saw) and the upstream direction is four ordinary
 * POSTs. The only thing given up is client→server streaming, which nothing here wants.
 *
 * ── This is a trust boundary ─────────────────────────────────────────────────
 * The port is bound to every interface by default and the thing behind it is an agent with
 * full tool access. So: every body is validated by a `.strict()` zod schema in `protocol.ts`
 * and never cast; every route but the page and the login itself requires a session cookie; a
 * file the agent sent is reachable only through an opaque token, never a path; and anything
 * downloaded is served `attachment` + `nosniff` so an agent-sent `.html` can never execute on
 * this origin.
 *
 * ── Built for a weak link ────────────────────────────────────────────────────
 * Everything compressible is compressed, including the event stream — which is the part with a
 * trap in it: a gzip stream buffers until it is told not to, so each event is followed by an
 * explicit `Z_SYNC_FLUSH`. Without that the page receives nothing at all until the connection
 * closes, which is indistinguishable from a hung daemon and is exactly the failure this pass
 * exists to prevent. `server.test.ts` pins it.
 *
 * A reconnect resumes: the browser sends `Last-Event-ID`, and the room replays only what that
 * client missed instead of the whole conversation. See `room.ts`.
 *
 * ── Shutting down ────────────────────────────────────────────────────────────
 * `stop()` is on the daemon's exit path: `Daemon.stop()` awaits it, and the signal handler only
 * calls `process.exit` in that promise's `finally`. `server.close()` alone would never return
 * here — its callback waits for every connection to end, and an event stream by definition
 * never does. So `stop()` ends the streams itself (gzip stream included, not just the
 * response), then closes connections, with a timeout as a backstop. Getting this wrong does not
 * leak a socket; it hangs Ctrl-C forever.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { constants as zlibConstants, createGzip, gzipSync } from 'node:zlib';

import { sessionCookie, type WebAuth } from './auth.js';
import { renderPage } from './page.js';
import {
  ClickRequestSchema,
  CreateTopicRequestSchema,
  DeleteTopicRequestSchema,
  LoginRequestSchema,
  MAX_BODY_BYTES,
  SendRequestSchema,
  parseBody,
  type WebEvent,
} from './protocol.js';
import type { WebRoom, WebuiInstance } from './room.js';

export interface WebServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Keeps proxies and NAT tables from dropping an idle stream. A comment line, not an event. */
const HEARTBEAT_MS = 25_000;

/** How long `stop()` waits for connections to end before destroying them. */
const SHUTDOWN_GRACE_MS = 2_000;

/** Below this, gzip's own framing costs more than it saves. */
const MIN_COMPRESS_BYTES = 512;

/** One attached event stream, with whatever sits between it and the socket. */
interface Stream {
  write(chunk: string): void;
  end(): void;
}

export function createWebServer(room: WebRoom, auth: WebAuth, instance: WebuiInstance): WebServer {
  const sockets = new Set<Socket>();
  const streams = new Set<Stream>();
  const ctx: Ctx = { room, auth, instance, streams };

  const server = createServer((req, res) => {
    void route(req, res, ctx).catch((e: unknown) => {
      console.error('[webui] request failed:', e instanceof Error ? (e.stack ?? e.message) : e);
      if (!res.headersSent) send(req, res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': ping\n\n');
  }, HEARTBEAT_MS);
  // Unref'd so this interval can never be the reason the process stays alive — `daemon.stop()`
  // is called directly by several tests, and a live timer there hangs the runner.
  heartbeat.unref();

  return {
    start: () => listen(server, instance, room),
    stop: () => shutdown(server, streams, sockets, heartbeat),
  };
}

function listen(server: Server, instance: WebuiInstance, room: WebRoom): Promise<void> {
  return new Promise((resolve, reject) => {
    // A bind failure arrives as an 'error' EVENT, asynchronously — not as a throw from listen().
    // Without this, EADDRINUSE would surface as the daemon's global [uncaughtException] handler
    // and the daemon would run on with a dead UI and no clue why.
    const onError = (e: Error): void => {
      server.off('listening', onListening);
      reject(new Error(`[webui] cannot bind ${instance.host}:${instance.port}: ${e.message}`));
    };
    const onListening = (): void => {
      server.off('error', onError);
      server.on('error', (e) => console.error('[webui] server error:', e.message));
      announce(instance, room);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(instance.port, instance.host);
  });
}

/**
 * Say where it is listening and what is, and is not, protecting it.
 *
 * The loud version when the bind is not loopback, because that is a security posture the
 * operator chose in one line of YAML and will not otherwise be reminded of: there is no TLS
 * here, and the shared secret is the whole of the door.
 */
function announce(instance: WebuiInstance, room: WebRoom): void {
  const where = `http://${instance.host}:${instance.port}`;
  console.log(
    `[webui] "${instance.id}" listening on ${where} — ${room.topics.list().length} topic(s), ${room.watchers} client(s) attached`
  );
  if (instance.host !== '127.0.0.1' && instance.host !== 'localhost' && instance.host !== '::1') {
    console.warn(
      `[webui] "${instance.id}" is reachable from the network and speaks plain HTTP: the shared ` +
        `token is the only thing between it and an agent with full tool access. Put TLS in front ` +
        `of it before exposing it beyond a network you control, or bind host: 127.0.0.1 and tunnel.`
    );
  }
}

async function shutdown(
  server: Server,
  streams: Set<Stream>,
  sockets: Set<Socket>,
  heartbeat: NodeJS.Timeout
): Promise<void> {
  clearInterval(heartbeat);
  for (const stream of streams) {
    // Tell the page to stop reconnecting BEFORE dropping it; see the `bye` event's doc. `end()`
    // finishes the gzip stream where there is one — ending only the response would leave the
    // compressor's tail unwritten and the socket open.
    try {
      stream.write(`data: ${JSON.stringify({ t: 'bye' } satisfies WebEvent)}\n\n`);
      stream.end();
    } catch {
      // Already gone. Nothing to do and nothing worth logging on the way out.
    }
  }
  streams.clear();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      finish();
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    server.close(() => finish());
    server.closeIdleConnections();
    server.closeAllConnections();
  });
  sockets.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  room: WebRoom;
  auth: WebAuth;
  instance: WebuiInstance;
  streams: Set<Stream>;
}

/** One request, already parsed as far as routing needs it. */
interface Req {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The part of the path a prefix route did not match. */
  rest: string;
}

interface Route {
  method: string;
  path: string;
  prefix?: boolean;
  run: (rq: Req, ctx: Ctx) => Promise<void> | void;
}

/** Reachable without a session: the page itself, and the exchange that gets you one. */
const OPEN: Route[] = [
  { method: 'GET', path: '/', run: ({ req, res }, ctx) => sendPage(req, res, ctx.instance) },
  { method: 'POST', path: '/api/login', run: login },
];

/** Everything else. */
const GUARDED: Route[] = [
  { method: 'GET', path: '/api/events', run: stream },
  { method: 'POST', path: '/api/send', run: submit },
  { method: 'POST', path: '/api/click', run: click },
  { method: 'POST', path: '/api/topics', run: createTopic },
  { method: 'POST', path: '/api/topics/delete', run: deleteTopic },
  { method: 'DELETE', path: '/api/topics', run: deleteTopic },
  { method: 'POST', path: '/api/logout', run: logout },
  { method: 'GET', path: '/f/', prefix: true, run: ({ req, res, rest }, ctx) => download(req, res, ctx.room, rest) },
];

/**
 * A table rather than a chain of ifs, for two reasons beyond the complexity limit: the two
 * lists ARE the answer to "what can be reached without signing in", which is worth being able
 * to read at a glance; and a route added to the wrong list is then a visible mistake rather
 * than a missing `if`.
 */
function match(routes: readonly Route[], method: string, path: string): { route: Route; rest: string } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.prefix) {
      if (path.startsWith(route.path)) return { route, rest: path.slice(route.path.length) };
    } else if (path === route.path) {
      return { route, rest: '' };
    }
  }
  return undefined;
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';

  const open = match(OPEN, method, url.pathname);
  if (open) return open.route.run({ req, res, url, rest: open.rest }, ctx);

  // One gate for everything else, rather than a check inside each handler, so a route added
  // later is protected by default instead of by remembering.
  if (!ctx.auth.check(req.headers.cookie)) return send(req, res, 401, { error: 'not signed in' });
  if ((method === 'POST' || method === 'DELETE') && !sameOrigin(req)) return send(req, res, 403, { error: 'cross-origin request refused' });

  const guarded = match(GUARDED, method, url.pathname);
  if (guarded) return guarded.route.run({ req, res, url, rest: guarded.rest }, ctx);
  send(req, res, 404, { error: 'no such route' });
}

function logout({ req, res }: Req, ctx: Ctx): void {
  ctx.auth.revoke(req.headers.cookie);
  send(req, res, 200, { ok: true });
}

function sendPage(req: IncomingMessage, res: ServerResponse, instance: WebuiInstance): void {
  body(req, res, 200, Buffer.from(renderPage(instance.title), 'utf8'), {
    'Content-Type': 'text/html; charset=utf-8',
    // The page is the app; a stale cached copy after an upgrade is a support question.
    'Cache-Control': 'no-store',
    // Belt and braces around web-markdown's escaping: even if something did get through, an
    // inline script from it would not run and no external origin could be reached.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
}

async function login({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, LoginRequestSchema);
  if (!parsed) return;
  // The socket address, only ever as a throttling key — never logged, never authorization.
  const result = ctx.auth.login(parsed.token, req.socket.remoteAddress ?? 'unknown');
  if (!result.ok) {
    const status = result.reason === 'throttled' ? 429 : 401;
    if (result.reason === 'throttled') res.setHeader('Retry-After', String(result.retryAfterSec));
    console.warn(`[webui] "${ctx.instance.id}": login refused (${result.reason})`);
    return send(req, res, status, { error: result.reason });
  }
  res.setHeader('Set-Cookie', sessionCookie(result.sessionId, isSecure(req)));
  send(req, res, 200, { ok: true });
}

/**
 * Attach an event stream to one topic.
 *
 * Per topic, not per connection to the whole UI: a client reading one room should not be
 * billed for traffic in another, which on a weak link is the difference between usable and
 * not. The topic LIST still reaches every client (see `WebRoom.announceTopics`), so the
 * switcher stays current without subscribing to rooms nobody is reading.
 */
function stream({ req, res, url }: Req, ctx: Ctx): void {
  const wanted = url.searchParams.get('t');
  const topic = wanted && ctx.room.topics.has(wanted) ? wanted : ctx.room.topics.current().id;
  const out = openStream(req, res);
  ctx.streams.add(out);
  const lastId = req.headers['last-event-id'];
  const unsubscribe = ctx.room.subscribe(
    topic,
    (id, ev) => out.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(ev)}\n\n`),
    Array.isArray(lastId) ? lastId[0] : lastId
  );
  req.on('close', () => {
    unsubscribe();
    ctx.streams.delete(out);
  });
}

/** Open the response as an event stream, compressed when the client will take it. */
function openStream(req: IncomingMessage, res: ServerResponse): Stream {
  const gzip = acceptsGzip(req);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // `no-transform` and `X-Accel-Buffering` both say the same thing to different proxies: do
    // not buffer this. nginx buffers SSE by default, and a buffered stream shows nothing at all
    // until the turn ends — which reads exactly like a hung daemon.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.flushHeaders();
  if (!gzip) {
    return { write: (chunk) => void res.write(chunk), end: () => res.end() };
  }
  const gz = createGzip();
  gz.pipe(res);
  return {
    // Z_SYNC_FLUSH after EVERY event, and this is the whole trap of compressing a stream: a
    // gzip stream buffers until told otherwise, so without it the browser receives nothing
    // until the connection closes — a live UI that shows the entire turn at the end of it.
    write: (chunk) => {
      gz.write(chunk);
      gz.flush(zlibConstants.Z_SYNC_FLUSH);
    },
    end: () => gz.end(),
  };
}

async function submit({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, SendRequestSchema);
  if (!parsed) return;
  switch (ctx.room.submit(parsed)) {
    case 'unknown-topic':
      return send(req, res, 404, { error: 'no such topic' });
    // A retry of something already accepted, which is the point of the nonce — answer as if
    // this were the original, because for the caller it is.
    case 'duplicate':
    case 'accepted':
      return send(req, res, 202, { ok: true });
  }
}

async function click({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, ClickRequestSchema);
  if (!parsed) return;
  // An id the room does not hold is a stale tab or a hand-made request; either way the daemon's
  // click handlers would go on to EDIT whatever it names, so it stops here.
  if (!ctx.room.click(parsed)) return send(req, res, 409, { error: 'that message is gone' });
  send(req, res, 202, { ok: true });
}

async function createTopic({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, CreateTopicRequestSchema);
  if (!parsed) return;
  try {
    send(req, res, 201, { topic: ctx.room.createTopic(parsed.title ?? '') });
  } catch (e) {
    // The store refuses past its cap rather than evicting, because evicting a topic would
    // orphan a live agent session. Say so instead of failing anonymously.
    send(req, res, 409, { error: e instanceof Error ? e.message : 'could not create a topic' });
  }
}

async function deleteTopic({ req, res }: Req, ctx: Ctx): Promise<void> {
  const parsed = await readBody(req, res, DeleteTopicRequestSchema);
  if (!parsed) return;
  if (!ctx.room.deleteTopic(parsed.topic)) {
    return send(req, res, 404, { error: 'no such topic' });
  }
  send(req, res, 200, { ok: true });
}

async function download(req: IncomingMessage, res: ServerResponse, room: WebRoom, token: string): Promise<void> {
  const entry = room.resolveDownload(decodeURIComponent(token));
  if (!entry) return send(req, res, 404, { error: 'no such file' });
  const size = await stat(entry.path).then(
    (s) => s.size,
    () => undefined
  );
  if (size === undefined) return send(req, res, 404, { error: 'that file is no longer on disk' });
  res.writeHead(200, {
    // Never the file's own type, and always an attachment: an agent that sent an .html or .svg
    // would otherwise get it rendered on this origin, holding this session's cookie.
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': disposition(entry.name),
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(entry.path).pipe(res);
}

/** A `Content-Disposition` a filename cannot break out of, in both the ASCII and UTF-8 forms. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\w.\- ]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read, parse and validate a JSON body, answering the request itself on any failure.
 *
 * Returns `undefined` to mean "already answered, stop" — the alternative, throwing, would put
 * a routine oversized upload through the 500 path.
 */
async function readBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: Parameters<typeof parseBody<T>>[0]
): Promise<T | undefined> {
  // Requiring JSON is half the CSRF story: a form or an <img> can only produce a simple
  // request, which cannot carry this content type without a preflight.
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    send(req, res, 415, { error: 'expected application/json' });
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      send(req, res, 413, { error: 'that is too large to send' });
      req.destroy();
      return undefined;
    }
    chunks.push(buf);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    send(req, res, 400, { error: 'malformed JSON' });
    return undefined;
  }
  const parsed = parseBody(schema, raw);
  if (!parsed.ok) {
    send(req, res, 400, { error: parsed.error });
    return undefined;
  }
  return parsed.value;
}

/**
 * Refuse a state-changing request that a different origin sent.
 *
 * The session cookie is already `SameSite=Strict`, so a browser will not attach it cross-site;
 * this is the second lock, and the one that still works if that attribute is ever relaxed. A
 * missing `Origin` is allowed through: `curl` and the reverse CLI send none, and they are not
 * the threat this is about.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Whether the request reached us over TLS, including via a proxy that says so. */
function isSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (proto ?? '').split(',')[0]?.trim() === 'https';
}

function acceptsGzip(req: IncomingMessage): boolean {
  const accept = req.headers['accept-encoding'];
  return (Array.isArray(accept) ? accept.join(',') : (accept ?? '')).includes('gzip');
}

function send(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
  body(req, res, status, Buffer.from(JSON.stringify(payload), 'utf8'), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

/** Write a finished response, compressed when it is worth it and the client will take it. */
function body(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: Buffer,
  headers: Record<string, string>
): void {
  const compress = payload.length >= MIN_COMPRESS_BYTES && acceptsGzip(req);
  const out = compress ? gzipSync(payload) : payload;
  res.writeHead(status, {
    ...headers,
    'Content-Length': out.length,
    ...(compress ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
  });
  res.end(out);
}
