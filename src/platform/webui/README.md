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
| `room.ts` | The conversations — per-topic message rings, subscribers, the hold queue, both directions of traffic. No HTTP. |
| `topics.ts` | The topic list and its file. Shaped like `daemon/workdir-usage.ts`. |
| `server.ts` | `node:http`: routes, auth gate, SSE, upload, download, shutdown |
| `auth.ts` | Shared-secret login, session cookies, brute-force throttle |
| `protocol.ts` | `.strict()` zod schemas for every inbound body; the outbound event union |
| `page.ts` | The whole page (HTML + CSS + JS) as a module-level string |
| [`../web-markdown.ts`](../web-markdown.ts) | Markdown → escaped HTML; lives with the other converters |

`room.ts` is deliberately free of HTTP so the adapter's behaviour is testable without opening
a port — which is what `room.test.ts` and `index.test.ts` do.

## Topics

A topic is a LANE on the one channel: `{ channel: 'main', thread: '<topic id>' }`. Each is its
own conversation, with its own agent session and its own harness-generated name — the shape a
Telegram forum topic or a Feishu 话题群 has, in a browser.

**A lane rather than a channel of its own, and that is not arbitrary.** Both would give
separate conversations: `conversationKey` under the default `per_thread` scope is
`platform#channel#thread`, so either varying part separates them. The difference is naming.
`retitleLane` refuses any address with no lane, so `capabilities.renameThread` is only ever
true for a lane — a channel-per-topic design would have left the automatic naming permanently
inert, and that naming is half of what makes topics worth having.

**`kind` stays `'direct'` even though a lane is set, and this one is a trap worth knowing
about.** `shouldRespond` (`core/inbound-gate.ts`) answers a DM at step 3 and only reaches its
mention requirement at step 6. A `kind: 'thread'` message that is not a DM, has no active
session yet, and carries no @ falls through to that step — and `chat.requireMention` defaults
to true, so **the first message in every new topic would be silently dropped**. `'direct'`
short-circuits before that while `conversationKey` still separates by lane and `retitleLane`
still works. A DM that has lanes is a shape the gateway already knows: a Telegram DM topic.

**Ids are hex and may not contain `/`.** A topic id travels as the lane half of `main/<id>`,
which `parseAddress` splits on `/` and refuses to see twice — so an id with one in it would
break `--channel` and the `chat.channels` allowlist far from here. `protocol.ts` rejects the
wrong shape at the request boundary.

**Message ids are global and never reused**, not per topic. The outbound pacer coalesces edits
into `edit:<channel>:<messageId>` and every topic shares the one channel, so an id restarting
per topic would let one topic's edits supersede another's. For the same reason all topics share
one rate-limit budget — exactly as Telegram forum topics share their chat's.

**The topic list is persisted; the transcripts are not.** Losing the list is not "the page looks
empty": `conversations.json` still holds the agent binding and session id under
`<instance>#main#<topic id>`, so every context would still be running and no longer reachable.
See `topics.ts` for why its `title` duplicates one the daemon also stores.

**`access.allowFrom` identity is `<instance id>:owner`**, the same for every topic. An existing
config that already lists other identities will silently ignore every message typed into this
page until that entry is added — `doctor` checks for exactly this.

**`access.allowFrom` identity is `<instance id>:owner`.** An existing config that already
lists other identities will silently ignore every message typed into this page until that
entry is added — `doctor` checks for exactly this.

## Capabilities

| | value | why |
|---|---|---|
| `editMessage` | ✓ | Redrawing a message is what a DOM does |
| `reaction` / `typing` | ✓ | Nothing in the daemon reads either flag; the real obligation is that the methods are safe to call |
| `reply` | ✓ | Rendered as a quote above the body |
| `thread` / `renameThread` | ✓ | Topics, and topics that name themselves. The second is only possible because the first is a lane |
| `buttons` / `editButtons` | ✓ | Both, or `/model`, `/cd` and `/setting` silently degrade to plain text |
| `menuPageSize` | 12 | The same number every other platform declares. A browser could carry more; that is not a reason to make it the odd one out, and `menu-page-size.test.ts` holds that invariant for the profiles it can see |
| `slashCommands` | ✓ | *Received*, as ordinary text, exactly like Telegram — `registerCommands` only feeds the page's autocomplete |
| `slashNeedsAck` | – | There is no interaction to close out |
| `maxMessageLength` | 20000 | Not a platform limit. A ceiling so one runaway reply does not become an unbounded DOM node redrawn several times a second |
| `maxEditsPerMessage` | unset | Nothing here ever refuses an edit |

## Built for a bad connection

Three things here exist because this is expected to be read over a weak link, and each would be
simpler without that constraint. Together they took a 30-second streamed answer from 13 updates
and ~2.6 KB to 3 updates and ~600 bytes.

**Edits are held, not broadcast.** Every streaming flush re-renders the whole message, so
announcing each one sends the same growing body over and over. An edit is queued and emitted
once the message stops changing, or after a cap so a long reply still shows progress.
`SETTLE_MS` cannot be read on its own: it is 1500ms because `EXPERIENCE.stream.flushIntervalMs`
is 1200ms, and anything below that expires between every pair of edits — announcing each one
separately, adding a fixed delay to all of them, and saving nothing. If that 1200 moves, this
has to move with it.

The ordering rule that makes holding safe: **any non-edit event flushes the queue first.** A
tool bubble is a new message (flush), its progress is an edit (held), and the next segment's
text is another new message (flush) — so the bubble's final state always arrives above the text
that followed it. Getting that backwards is the scrambled transcript
`daemon/render-order.test.ts` exists for, one layer up.

**A dropped stream resumes.** Every event carries a sequence number written as the SSE `id:`
field, and each topic keeps a backlog of the last 300. `EventSource` sends back the last id it
saw, and the room replays only what that client missed. Before this, every network blip cost a
full re-send of the conversation. A `Last-Event-ID` the backlog no longer reaches falls back to
a full sync rather than handing over a transcript with a hole in it, and the cross-topic
`topics` event deliberately carries no id so it cannot move a resume point.

**Everything is compressed**, the event stream included — which is the part with a trap in it.
A gzip stream buffers until told otherwise, so each event is followed by an explicit
`Z_SYNC_FLUSH`. Without it the page receives nothing until the connection closes, which is
indistinguishable from a hung daemon. `server.test.ts` pins it, and the test hangs rather than
failing an assertion if the flush goes away — which is the honest reproduction.

**Sends are idempotent.** A POST can be accepted and still time out on a bad link, so the page
retries — which is only safe because each send carries a nonce the server remembers. The
daemon's own inbound dedup cannot help here: it keys on a message id, and a retry mints a fresh
one.

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
- **A reverse proxy must not buffer**, and must not strip `Content-Encoding` without
  re-adding it. `proxy_buffering off;` in nginx.
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
