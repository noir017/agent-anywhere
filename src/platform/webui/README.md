# `src/platform/webui/` — the built-in web UI

A browser chat page the daemon serves itself, wired in as a ninth platform. No account, no
bot token, no upstream service: `agent-anywhere start`, open the page, type.

It exists because every other way into this gateway needs a chat platform configured first.
When there isn't one — or when a browser is simply the place you want to be — this is the
door.

## The one structural decision

**It is not a Satori adapter, and it does not use the profile seam.**

Every other platform is assembled by [`satori-core.ts`](../satori-core.ts) from a
`PlatformProfile`, and that assembly is built around a Satori `Bot`: resolve one, call
`bot.sendMessage`, normalise a `Session` into an `InboundMessage`, delegate the platform's
differences to the profile. Here the daemon owns both ends of the conversation. There is no
bot, no gateway, no session. Forced through the seam, every profile method would be a stub
around state this module holds anyway.

So it implements [`PlatformAdapter`](../adapter.ts) directly, which is all `daemon/` ever
sees. `platform-factory.ts` dispatches on `type === 'webui'` before it reaches `PROFILES`,
and that map is typed `Record<Exclude<PlatformType, 'webui'>, …>` so the next Satori platform
still fails to compile until it is listed. The shape is the same one
[`daemon/agent-agy.ts`](../../daemon/README.md) uses: a sibling runtime, not a pretend member
of a protocol it does not speak.

### What bypassing `satori-core` costs

Everything `satori-core` does for *every* platform has to be done again here, and the failure
mode of forgetting one is silence rather than an error. Each is re-implemented with a comment
naming it, and they are all of them:

| What | Where it is here | What its absence would look like |
|---|---|---|
| `chat.channels` listen allowlist | `room.ts` `channelAllowed` | The config field parses and does nothing |
| The `[in]` log line | `room.ts` `submit` | Inbound traffic invisible in the log |
| Connection logging | `room.ts` `subscribe`, `server.ts` `announce` | No way to tell "nobody is watching" from "nothing was sent" |
| `measureRendered` | `index.ts` — identity | Replies chopped at a third of the stated limit |
| Typed outbound failures | `room.ts` `mustFind` | An edit to an evicted message succeeds silently and its text is lost |

## Files

| File | Role |
|---|---|
| `index.ts` | The `PlatformAdapter`: capability declaration + the outbound methods |
| `room.ts` | The conversation — message ring, subscribers, both directions of traffic. No HTTP. |
| `server.ts` | `node:http`: routes, auth gate, SSE, upload, download, shutdown |
| `auth.ts` | Shared-secret login, session cookies, brute-force throttle |
| `protocol.ts` | `.strict()` zod schemas for every inbound body; the outbound event union |
| `page.ts` | The whole page (HTML + CSS + JS) as a module-level string |
| [`../web-markdown.ts`](../web-markdown.ts) | Markdown → escaped HTML; lives with the other converters |

`room.ts` is deliberately free of HTTP so the adapter's behaviour is testable without opening
a port — which is what `room.test.ts` and `index.test.ts` do.

## One conversation

The page is a single room: `{ channel: 'main', kind: 'direct', user: 'owner' }`. No sidebar,
no room list, no threads. A second conversation is a second `platforms:` entry on a second
port.

That is why `thread` and `renameThread` are declared false. `renameThread` in particular
*could* have been true — but `retitleLane` refuses any address with no lane, so it would have
traded one accurate refusal ("this platform cannot") for a less accurate one ("there is no
name to change") and bought nothing. `/title` says the first.

`kind: 'direct'` matters: the inbound gate answers a DM with `respondInDirect` and never asks
for a mention, which is the right behaviour for a page with one person on it.

**`access.allowFrom` identity is `<instance id>:owner`.** An existing config that already
lists other identities will silently ignore every message typed into this page until that
entry is added — `doctor` checks for exactly this.

## Capabilities

| | value | why |
|---|---|---|
| `editMessage` | ✓ | Redrawing a message is what a DOM does |
| `reaction` / `typing` | ✓ | Nothing in the daemon reads either flag; the real obligation is that the methods are safe to call |
| `reply` | ✓ | Rendered as a quote above the body |
| `thread` / `renameThread` | – | See above |
| `buttons` / `editButtons` | ✓ | Both, or `/model`, `/cd` and `/setting` silently degrade to plain text |
| `menuPageSize` | 12 | The same number every other platform declares. A browser could carry more; that is not a reason to make it the odd one out, and `menu-page-size.test.ts` holds that invariant for the profiles it can see |
| `slashCommands` | ✓ | *Received*, as ordinary text, exactly like Telegram — `registerCommands` only feeds the page's autocomplete |
| `slashNeedsAck` | – | There is no interaction to close out |
| `maxMessageLength` | 20000 | Not a platform limit. A ceiling so one runaway reply does not become an unbounded DOM node redrawn several times a second |
| `maxEditsPerMessage` | unset | Nothing here ever refuses an edit |

## Transport: SSE, not WebSocket

`GET api/events` is an event stream; the page uses the browser's own `EventSource`, which
reconnects by itself. Upstream is three ordinary POSTs. Node has no WebSocket server, so the
alternative meant a new dependency for one local page, and the only thing given up is
client→server streaming, which nothing wants.

Server→client events are **upsert by id**: a message the page already holds is replaced. One
event kind rather than separate send/edit kinds, because a client that reconnects mid-turn
receives an "edit" for an id it has never seen, and would have to treat it as an append
anyway.

Two consequences worth knowing:

- **`sendMessage` resolves whether or not anybody is watching.** The ring is the
  conversation; clients are a fan-out of it. An adapter that failed with no browser open
  would fail every turn started before someone opened the page — and the daemon would report
  that failure by posting into the same empty room.
- **An edit to an id the ring has evicted throws `MessageNotEditableError`**, not a silent
  success. `StreamBuffer` answers it by sealing and continuing in a fresh message. A silent
  success would have it record text as delivered that nobody can see.

## Security

New trust boundary, so it is spelled out. The port binds every interface by default and what
is behind it is an agent with full tool access.

1. **One shared secret**, compared with `timingSafeEqual`, exchanged for a `randomUUID`
   session in an `HttpOnly; SameSite=Strict` cookie. Sessions are in memory, bounded, and
   expire after a week of disuse; a restart logs everyone out. This is not per-person
   identity — everyone holding the secret is the same operator, and shares the conversation.
2. **Five guesses a minute per source**, then a lockout, so the secret cannot be ground down
   online.
3. **Two locks on CSRF**: `SameSite=Strict`, plus a required `application/json` content type
   (which a form or an `<img>` cannot produce without a preflight) and an `Origin`/`Host`
   agreement check.
4. **`web-markdown.ts` escapes everything before it builds a tag, and there is no raw-HTML
   passthrough.** This is the load-bearing one: what it renders is agent output, which
   carries the bytes of every file the agent read. An `<img onerror=…>` in a grepped file
   would otherwise execute on a page holding this session's cookie.
5. **Downloads are opaque tokens, served `attachment` + `nosniff` as
   `application/octet-stream`** — never the file's own type, so an agent-sent `.html` cannot
   render on this origin. A path never reaches the browser and the browser can never name one.
6. **Uploads become `data:` URLs**, the shape `adapter-telegram` already uses, so
   `daemon/attachment-io.ts` handles them through its existing branch and its SSRF guard has
   nothing to act on. A temp file and a `file://` URL would be refused by that guard outright.

**Not solved here:** TLS (put a reverse proxy in front), and DNS rebinding — a `Host`
allowlist would break the reverse-proxy deployment this is expected to run behind, so the
shared secret is what stands in its place.

## Things that bite

- **Shutdown.** `server.close()` alone never returns: its callback waits for every connection
  to end, and an event stream by definition never does. `stop()` ends the streams itself
  (with a `bye` event, because `EventSource` reconnects after a *clean* close too), then
  `closeIdleConnections` / `close` / `closeAllConnections`, behind a timeout. Get this wrong
  and Ctrl-C hangs the daemon forever, because the signal handler's `process.exit` lives in
  that promise's `finally`.
- **`page.ts` is invisible to the toolchain.** Not typechecked, not linted, not unit-tested —
  to TypeScript it is a string. So the script is kept stupid, uses string concatenation
  rather than template literals (a literal `` ` `` or `${` would be eaten by the surrounding
  template and become a module-load error), and `page.test.ts` at least proves it parses.
  Any change that needs a new *decision* belongs on the other side of the wire.
- **A reverse proxy must not buffer.** nginx buffers SSE by default; the response carries
  `X-Accel-Buffering: no` and `Cache-Control: no-transform`, but a proxy configured to ignore
  them shows nothing until the turn ends, which reads exactly like a hung daemon. Set
  `proxy_buffering off;`.
- **The page is empty after a restart while the agent still remembers everything.** The ring
  is memory; the agent's session is persisted by `conversation-store.ts`. So `/context` will
  report real numbers against a blank transcript. Deliberate — persisting a chat log to disk
  is a different feature with different questions attached.

## Testing

Everything here is locally exercisable — no live network path, unlike the Satori profiles —
so it is tested rather than verified by hand: `web-markdown.test.ts` (escaping and stream
safety), `auth.test.ts` (constant-time compare, throttle, expiry), `protocol.test.ts` (strict
rejection), `room.test.ts` and `index.test.ts` (the adapter contract), `server.test.ts` (real
sockets: the auth gate, the CSRF locks, the download headers, and that `stop()` terminates
with a stream open), `page.test.ts` (the script parses and nothing was eaten).
