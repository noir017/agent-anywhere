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
| `server.ts` | `node:http`: routes, auth gate, SSE, upload, download, the upgrade gate, shutdown |
| `auth.ts` | Shared-secret login, session cookies, brute-force throttle |
| `sso.ts` | The other door: an RS256 assertion from the proxy in front, verified against its JWKS |
| `terminal-proxy.ts` | Byte-for-byte reverse proxy to the terminal's ttyd over a unix socket. Speaks no WebSocket. |
| `terminal-sessions.ts` | The bookkeeping either side of those bytes: who is attached, and the operator's command for ending a session |
| `protocol.ts` | `.strict()` zod schemas for every inbound body; the outbound event union |
| `page.ts` | The whole page (HTML + CSS + JS) as a module-level string |
| `manifest.ts` | The web app manifest and the icon, as strings, for the same reason `page.ts` is one |
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
See `topics.ts` for why its `title` duplicates one the daemon also stores. The *browser* keeps a
rotating copy of the transcripts ([below](#the-local-transcript-cache)); the daemon still does
not, and nothing here reads that cache back.

**Neither the per-topic `×` nor "Clear all topics" ends an agent session.** Both reach exactly as
far as this module: the room goes, the list entry goes, and the daemon's binding under
`<instance>#main#<topic id>` stays behind. That is the same trade the cap in `topics.ts` refuses
to make automatically — it is a list being cleared, not sessions being killed. The sweep exists
because a restart leaves a sidebar full of rows that open onto nothing (see `stale` below), and
deleting a dozen of those one at a time is not a feature.

**Each row also says which directory that topic works in**, which is the one thing a title does
not tell you when several topics are open on different projects. It is not stored beside the
title, though, and that asymmetry is deliberate: the title is *this module's* (a topic has one
before a turn has ever run), while the directory is the daemon's and moves under `/cd`, so a
copy here would be a second answer that outlives the real one. The daemon hands the adapter a
lookup instead (`PlatformAdapter.useWorkdirLookup`), and `topicList()` asks it — memoised for
`DIR_TTL_MS`, because the list is rebuilt on every posted message and the lookup stats the
filesystem on the other side. A deployment that never offers one shows no second line at all.

**The dot on each row is about the agent, not about the turn.** Four states, and two of them
exist because "a turn is running" turned out to be a bad proxy for both of the things a person
actually reads that column for:

| dot | means | where it comes from |
|---|---|---|
| grey | nothing resident — history, or a topic that will have to resume from a session id | the absence of the two below |
| dim blue | an agent child is up and idle | `PlatformAdapter.useLivenessLookup` |
| blue, pulsing | a turn is executing | `startTyping` / `stopTyping` |
| amber, pulsing | a question is on screen and nothing moves until it is answered | a message in the room still carrying buttons |

`asking` is derived HERE rather than asked of the daemon, because the room already holds the
fact: every ask, elicitation round and menu arrives as a message with buttons and is retired by
stripping them. Note that it overlaps `running` rather than replacing it — the turn a question
belongs to is still open, typing and all — so anything rendering this checks `asking` first.

`live` is the one thing in this module that is POLLED (`LIVENESS_POLL_MS`). Everything that
turns it on already announces the list; nothing announces it going off, because an idle reclaim
fires on a timer in a conversation nobody is touching and a crashed child is quieter still. The
poll skips itself while no browser is attached and sends only when a flag actually changed.

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

The one edit that is **not** held is an edit carrying buttons, and the reason is interaction
rather than ordering: the page disables a button the instant it is clicked and re-enables it only
when the message repaints. Holding that repaint for the settle window leaves the control the user
just pressed dead in their hand — on a multi-select question, where ticking and unticking land on
the same button, for a second and a half between every tap.

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
one. That nonce comes back out on the echo (`WebMessage.nonce`), which is how the page knows
which of its local bubbles the echo is.

**A message is on screen before the request leaves.** Waiting for the echo to draw it meant a
visibly empty transcript for as long as the round trip took — and on a request that failed after
its retries it meant the text was simply gone: out of the composer, never into the conversation,
nowhere to copy it back from. So `send` paints the message locally first, keyed `p:<nonce>`, and
the POST is a separate concern:

- while it is in flight the bubble is dimmed (`.pending`);
- the echo claims it by nonce and REUSES its node, so nothing re-runs the fade-in or moves the
  scroll for a message that has been on screen since it was typed;
- a failure leaves it there, edged red, carrying **Retry / Copy / Discard**. Retry re-posts the
  same nonce, so a request that actually landed cannot double.

The one asymmetry worth knowing: **Retry lives in memory and Copy does not.** The body it would
re-send holds its attachments as base64, and that is not something to write into a cache meant
for a transcript — so a failed message restored after a reload offers Copy and Discard alone,
rather than pretending it can re-send files it no longer has.

## The local transcript cache

A transcript lives in the daemon's memory. That is still true, and it used to mean the page went
blank whenever the daemon did. Now the browser keeps its own copy, in **IndexedDB** — one record
per topic, holding the message list as a JSON *string* rather than an object graph, so the byte
budget below is measurable and nothing rests on how a structured clone treats these objects.
localStorage was the obvious alternative and is too small: one topic with code blocks in it runs
to hundreds of kilobytes against a ~5MB origin budget shared with everything else.

It buys two things:

- **A topic paints before the stream has answered** — on a reload, on a topic switch, on a link
  slow enough that the round trip is visible.
- **A daemon restart costs the conversation its liveness, not its contents.** The old messages
  stay on screen, above a divider that says where they came from, and the agent still has the
  context to carry on below them.

**Messages are keyed `<epoch>:<id>`, not `<id>`, and that is load-bearing.** `nextId` counts from
`w1` per process, so a restarted daemon hands the same ids out again — verified on the wire: the
first message after a restart really is `w1` again. Keyed by id alone, that message would upsert
itself straight over a cached one and the transcript would quietly corrupt. `epoch` is the sync's
generation (`WebRoom`'s construction time); it is only ever compared for equality. A message from
another generation is *history*: it keeps its place at the top, it is never dropped by a
reconcile, and its buttons are stripped, because the process that would answer them is gone and
the id they name now means something else.

Cached messages of the CURRENT generation produce exactly the keys the incoming sync produces, so
the ordinary path — same daemon, cache matching the ring — reuses every node and writes no DOM at
all. The cache is a head start, not a second source of truth.

**Rotation, because a cache that only grows is the same bug more slowly.** The TAIL of a topic is
kept (200 messages, 512KB), the least recently written topics are evicted past 24, and a write
refused for space drops everything but the topic being read and tries once before the cache is
written off for the session with one `console.warn`. Writes are coalesced into a 400ms window:
a streamed reply upserts the same message every second or so and each one would otherwise
re-serialise the whole topic.

**A browser with no IndexedDB is a supported configuration.** Private windows and old engines
both produce one; the cache is the only thing that goes, and `page.dom.test.ts` holds that.

**What is NOT cached: a send still in flight.** Only a FAILED local message is written down. One
in flight is a question this tab alone can answer, and restoring it after a reload would either
duplicate a message the daemon did receive or claim one was lost that was not.

**The echo of your own message is not rendered markdown.** `renderBody` escapes it and stops
there, where the agent's side goes through `web-markdown.ts`. What the operator typed is a
prompt: the exact characters are what the agent received, and this echo is where that gets
checked — a numbered list that markdown renumbered read as a different message from the one in
the compose box. `.b .raw` in `page.ts` carries the `pre-wrap` that keeps its line breaks, since
nothing turned them into tags.

## Transport: SSE, not WebSocket

`GET api/events` is an event stream; the page uses the browser's own `EventSource`, which
reconnects by itself. Upstream is three ordinary POSTs. Node has no WebSocket server, so the
alternative meant a new dependency for one local page, and the only thing given up is
client→server streaming, which nothing wants.

One WebSocket does cross this server — the terminal's — but as bytes, not as a protocol. See
[the terminal pane](#the-terminal-pane).

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

**The page reconciles; it does not rebuild.** A `sync` carries the whole topic, and the obvious
reading of that — empty `#log`, paint it again — is what made entering a topic jarring: the
scroll container was destroyed along with its position, so a topic already painted from the
session cache still flashed through blank on its way to looking identical, and every message
re-ran its entrance animation. Instead each message in the sync is upserted by id, moved into
place (`appendChild` on a node that already exists moves it rather than cloning it), and
anything the sync no longer carries is dropped. `paint` writes no DOM at all when the markup it
builds matches what is there, so an unchanged message is genuinely untouched — which is also
what keeps a repaint from undoing the disabled state of a button the click handler just set.

While a topic's first sync is in flight the log holds message-shaped placeholders (`.sk`).
They are only ever shown into an EMPTY log: a topic painted from cache has real content to read,
and a reconnect where the conversation is still on screen must not replace it with grey bars.

A full log has the opposite problem, and `.syncing` answers it. With the cache warm, entering a
topic is instantaneous — and then, a second or two later, everything said in it while you were
elsewhere lands in one frame, with nothing in between having suggested more was coming. So
`adopt` follows the cached transcript with a line saying what is still outstanding, at the bottom
where the missing messages will land, and `reconcile` takes it away when the sync arrives. It is
worded and sized as a line about the room rather than shaped like a message on purpose: most
syncs add nothing, and a message-shaped placeholder would have promised one. `paint` keeps it
last — anything painted while it is up, including a message typed into the gap, goes above it.

## The terminal pane

Off by default. Turned on, the chat header grows a `>_` button that opens a terminal **window**
over the transcript — a shell in this machine, in which any coding-agent CLI can be run
directly, TUI and all.

**The daemon owns none of it.** It does not spawn a PTY and does not speak the terminal's
protocol; it proxies, behind the session cookie, to a [`ttyd`](https://github.com/tsl0922/ttyd)
already listening on a unix socket. The page embeds ttyd's own page in a same-origin iframe.

Why it is not built here, since "a terminal in the web UI" sounds like it should be: nothing in
this daemon has raw terminal output to offer in the first place. Both agent runtimes spawn their
child over plain pipes and read line-delimited JSON — a line that does not parse is *dropped*,
and the ACP handshake declares `terminal: false`. So the pane could never be a view onto the
agent; it has to be a second, parallel thing. Building that second thing meant a native PTY
binding (node-pty publishes no Linux prebuilds at all, so every Linux install would need a
compiler), xterm.js, a WebSocket server, scrollback, resize, reconnect and a mobile key bar.
ttyd is 1.3 MB of static binary that already does all of it, including CJK and IME handling this
page would otherwise have to re-earn. The cost of the trade is one config field and the operator
having to run ttyd; the benefit is that the feature added **no dependency to this package**.

What the pane shows is whatever that ttyd was told to run. That is exactly why it works with any
CLI — and also why nothing in it reaches the conversation: no transcript, no reverse CLI, no
topic history. The two share a topic id and nothing else.

### A window per topic, and what its two buttons mean

The window belongs to a topic, not to the page. Its title bar carries exactly two controls, and
the whole design is in the difference between them:

- **Minimize** hides it. The iframe stays mounted and its WebSocket stays up, so coming back is
  a repaint rather than a reconnect — and the switcher's marker stays lit.
- **Close** ends the session, after a confirmation. It is a server round trip, not a teardown,
  because dropping an iframe only hangs up on a shell that carries on without us.

Switching topics therefore does not move one window around: each topic keeps its own, mounted
and attached until it is closed. The alternative — a single window following whichever topic is
on screen — hangs up on the topic being left, which surprises (the terminal you minimized is
gone) and makes the marker meaningless, since at most one topic could ever be lit.

The marker itself is a `>_` glyph on the topic row, fed by `terminal-sessions.ts` counting the
**live connections** this daemon is proxying. Read it as "a page is attached to this topic's
terminal", not "a shell is alive over there" — those differ, and the difference is visible:
close every tab and every marker goes out while the sessions carry on. Counting connections is
the most this process can honestly know, because it is the only part of the terminal it touches.

Closing has to be a configured command for the same reason. A session survives a dropped
connection only because the operator's wrapper is `tmux new -A`; ttyd itself SIGHUPs its child.
Only they can say how that is reversed, so `terminal.endCommand` is theirs to write — and where
they have not written one, the window has **no close button at all** rather than one that
cannot work.

### Wiring

```yaml
platforms:
  web:
    type: webui
    token: ${WEBUI_TOKEN}
    terminal:
      enabled: true
      # Defaults to webui-term-<instance>.sock beside the daemon's own state.
      socket: /home/user/.config/agent-anywhere/webui-term-web.sock
      # Optional. Without it there is no close button — only minimize.
      # argv, never a shell string; {topic} is substituted into each element.
      endCommand: ["tmux", "-L", "aa-web", "kill-session", "-t", "aa-{topic}"]
```

and, outside this package, a ttyd on that socket:

```
ttyd -i <socket> -b /term -W -a -O -P 30 -T xterm-256color <wrapper> 
```

`-i` is a **unix socket, not a port** — nothing on the network can reach it, so the session
check in front of the proxy is the only way in rather than one of two. `-b /term` matches the
prefix route. `-a` lets the URL pass an argument to `<wrapper>`, which is how one ttyd serves a
terminal per topic; the daemon passes `?arg=<topic id>`.

The wrapper is expected to be `tmux new -A -s aa-<topic>` or equivalent. Without something
holding the session, ttyd forks a fresh process per connection and SIGHUPs it on disconnect — so
switching apps on a phone would kill whatever was running. With tmux, a drop is a redraw — and
`endCommand` is how the page gets to undo that on purpose.

### Security

Three things are load-bearing and none of them are obvious.

1. **An upgrade never reaches `route()`.** `createServer`'s request handler is not called for
   one, so the `OPEN`/`GUARDED` tables, the session check and the origin check simply do not
   apply. `upgrade()` in `server.ts` redoes all of it by hand. A WebSocket route added by
   editing those tables would be wide open while looking protected.
2. **For the handshake the Origin check is the only lock, not the second one.** A WebSocket
   handshake is exempt from the same-origin policy and carries cookies whatever `SameSite`
   says. So unlike `sameOrigin`, which lets a missing `Origin` through for curl's sake, the
   upgrade path *requires* one — no browser omits it on a handshake, and the curl-shaped caller
   that exemption exists for has no business here.
3. **`?arg=` is a browser string that reaches an exec.** It is checked against the topic store
   before ttyd sees it, and again by a pattern in the wrapper on the far side.
4. **`endCommand` is a second string from the browser reaching a command.** It runs through
   `execFile` with an argv array — no shell — so a substituted id is an argument and cannot
   become syntax however it is spelled. The `^[0-9a-f]{8}$` pattern and the topic-store check
   are the belt; the missing shell is the braces, and it is the one doing the work.

Two costs accepted knowingly. The iframe is **same-origin, which is not a sandbox**: an XSS in
ttyd's page would hold this session. A cross-origin frame would need `allow-same-origin` to keep
a session at all, which undoes the sandbox, so the alternative buys nothing — the trade is
ttyd's terminal against re-implementing it here. And turning this on moves the login token from
guarding *conversation with an agent* to guarding *an interactive shell*. The ceiling is the
same (the agent already has full tool access); the distance from a leaked token to arbitrary
commands is not.

### Things that bite here specifically

- **A FIN arrives as `end`, not `close`.** An `http.Server` socket whose peer hangs up keeps its
  own write side open and sits half-open indefinitely. Tearing down on `close` alone leaks a
  socket pair per closed terminal tab and leaves `server.close()` waiting on every one of them —
  measured, not theorised: the pair outlived a client `destroy()` by a full second and the close
  callback never fired. `terminal-proxy.ts` listens for `end` too, and `server.test.ts` pins it.
- **Do not re-compress the proxied response.** ttyd gzips its own 730 KB single-file page down
  to ~190 KB and says so in `Content-Encoding`. Sending that back through `body()` hands the
  browser a double-gzipped document.
- **No connection pool to ttyd.** `agent: false` on both proxied requests: a pooled idle socket
  is still a socket, so `server.close()` waits on it and ttyd holds a client it is not serving.
- **Mounted under a sub-path, ttyd's `-b` has to agree.** The page's iframe `src` is relative
  like every other URL here, so it follows the proxy prefix — but ttyd builds its own links from
  `-b`, which is a fixed string it cannot discover.
- **A blank pane with a healthy socket is usually the renderer.** ttyd defaults to xterm's WebGL
  backend, which paints nothing under a headless Chromium with no GPU (this is how the pane was
  first, wrongly, diagnosed as broken on mobile: the content was there, `tmux display` reported
  a correct 46×51 window, and only the pixels were missing). `-t rendererType=dom` is the first
  thing to try.
- **A minimized window is still a mounted iframe.** That is the point — the connection is what
  keeps the session attached and the marker lit — but it means visibility has to be a class on
  the iframe, never an unmount, and never the `hidden` attribute either: the rule that sizes an
  iframe (`display:block`) beats the user agent's `[hidden]{display:none}`, and the loser of
  that fight is not obvious from reading either rule.

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
   The one exception is [a raster image](#showing-a-picture-instead-of-a-download), which is
   served as itself so the page can draw it; `nosniff` is what keeps that from being a hole,
   and SVG is deliberately not in the set.
6. **Uploads become `data:` URLs**, the shape `adapter-telegram` already uses, so
   `daemon/attachment-io.ts` handles them through its existing branch and its SSRF guard has
   nothing to act on. A temp file and a `file://` URL would be refused by that guard outright.
7. **Three routes are open besides the page**: `manifest.webmanifest`, `icon.svg`, `icon.png`.
   They have to be — a browser fetches all three while deciding whether the site is
   installable, which happens before anyone signs in, and a 401 there is indistinguishable
   from "not installable". They carry the configured title and a drawing; the title is already
   in the `<title>` of the equally-open page, so this widens nothing.
8. **An upgrade is gated separately, because it has to be** — it never reaches `route()`, so
   nothing above applies to it automatically. See [the terminal pane](#the-terminal-pane).

**Not solved here:** TLS (put a reverse proxy in front), and DNS rebinding — a `Host`
allowlist would break the reverse-proxy deployment this is expected to run behind, so the
shared secret is what stands in its place.

### Showing a picture instead of a download

Point 5 has an exception, and it is the only place in this directory where a file leaves the
daemon as its own type. An agent that takes a screenshot is expecting it to be *looked at*, and
a download that has to be found in a folder and opened in another application is not that.

`room.ts` `inlineImageType` is the whole of the decision — one closed list of raster formats,
read by both ends so the tag the page writes and the headers the server sends cannot disagree
about the same file. `server.ts` uses it to pick `Content-Type` and `inline`; `index.ts` uses it
to set `file.image`, which is what makes the page draw an `<img>` instead of only a link.

Three things hold it up:

- **No SVG.** An `.svg` is XML with `<script>` in it that a browser runs as a document. It is
  the one image format that is also code, and it stays an octet-stream attachment — as do
  `.pdf` (a document format browsers render, with its own scripting) and everything else.
- **`nosniff` is what makes trusting the extension safe.** A file merely *named* `.png` is
  served as `image/png` and the browser is then forbidden from sniffing a document back out of
  it. It renders as a broken image, which is the correct outcome; without that header the same
  file would be stored XSS on the origin holding this session's cookie.
- **The link stays.** The picture is drawn *above* the download link, never instead of it — the
  link is still the only way to get the bytes onto disk, and it is what a picture whose file has
  since been evicted from the download table degrades to (the page hides the broken frame).

Tapping a picture fills the screen with it. Deliberately not a new tab: installed as an app
this page has no tab bar to come back from, and leaving the app to look at a screenshot is the
same friction the feature exists to remove.

The operator's *own* uploads are still shown as named chips, not thumbnails. They are base64 in
the request body and deliberately never stored — see [the local transcript
cache](#the-local-transcript-cache) for why that is the same reason a failed message cannot be
retried after a reload.

### The other door: `sso.ts`

Point 1 above is a secret with no name on it. `sso.ts` is the alternative for a deployment
that already runs behind an identity-aware proxy: Cloudflare Access and Teleport's Application
Service both authenticate a *person* and state who it was in an RS256 JWT, so the daemon
verifies that signature instead of asking for a password of its own. One module covers both —
they differ only in a header name, a JWKS URL and which claim holds the person.

`admitted()` in `server.ts` is the whole of the wiring: cookie first (a map lookup), then the
assertion (possibly a key fetch). The `upgrade()` gate calls the same function, because an
upgrade still reaches none of `route()`.

Four things there are decisions rather than detail:

- **`from` is required.** The signature is what makes a forged header useless; the CIDR
  allowlist is what keeps a mistake in `jwksUrl`/`issuer`/`audience`/`allow` from being fatal.
  Belt and braces, the way `ipc/server.ts` has both 0600 and a token. Refusals log the source
  address precisely because that line is how the operator discovers what to configure.
- **`alg` is not negotiable.** Only `RS256`, refused by name before a key is even looked up —
  `none` and an HMAC keyed with the public key are the two classic ways a verifier is talked
  out of verifying, and neither is reachable if the algorithm is fixed.
- **`audience` has no default**, and neither does anything else that decides *who* gets in. A
  permissive default would accept any token the provider ever signed, including one minted for
  a different application of the same tenant.
- **Keys are cached and refetched on an unknown `kid`, with a 10-second cooldown.** That
  cooldown is also how long a real rotation is refused for, hence "short": it bounds the
  provider at six requests a minute under a stream of junk `kid`s, and bounds a rotation at ten
  seconds of the retries the page makes anyway. A provider that goes away does **not** drop the
  keys already held — a blip at the IdP must not be a dead page.
- **`jwksUrl` must be https** (loopback excepted, for a stub). Every guarantee above reduces to
  "these keys are really the provider's", and `http://` hands that to anyone on the path.
- **`from` prefixes are parsed strictly**, because `Number('')` is 0 and `BlockList` is happy
  with a `/0` rule: `"10.0.0.1/"` would have been "every address on the internet" written as a
  typo, and the startup log would still have printed it as one host. Every malformation throws.

**Two boundaries this does not cross.** Admission is per *request*: an attached event stream and
an open terminal WebSocket outlive both `exp` and a removal from `allow`, because nothing
re-verifies a connection that is already running. And the cookie fallback is the proxy's cookie,
whose `SameSite` this code does not set — which is why the terminal's proxied responses carry
`frame-ancestors 'self'` and `X-Frame-Options` (`terminal-proxy.ts`) and the page's own CSP does
too. Framing a live terminal from another site is the attack that would otherwise be left open
by a cookie the daemon does not control.

`sso.password: false` closes the shared-secret door. The page then renders a gate with no field
in it (see `PASSWORD_GATE` / `SSO_GATE` in `page.ts`): under SSO there is no secret that works,
so a password box answers an expired provider session with "that is not the right token" and
sends the operator hunting for a credential instead of signing in again. `doctor` fetches the
JWKS and says how many keys it found — worth running before closing that door, because with it
shut an IdP outage locks everyone out.

`scripts/verify-sso.mts` drives the whole path against a real socket and a real JWKS server;
the unit tests inject `fetch`, so that script is the only thing that exercises the network hop.

## Installing it as an app

`manifest.ts` is what makes a phone offer "install" rather than "bookmark", and the page's
head carries the tags that go with it. Three things worth knowing before changing any of it.

**There is no service worker, and adding one for installability would be a mistake.** Chrome
dropped the service-worker-with-a-fetch-handler requirement — the check was a proxy for "has
an offline story", sites defeated it with empty handlers, and it was removed rather than
tightened ([Chrome for Developers](https://developer.chrome.com/blog/update-install-criteria),
read 2026-09-20). What remains is HTTPS and a manifest. A worker here would also mean caching
the app shell, and the shell is served `no-store` on purpose: a stale copy after an upgrade is
a support question with no error message. If offline reading is ever wanted, the local
transcript cache above is the place for it, not a second copy of the shell.

**The icon exists twice on purpose.** `ICON_SVG` is the drawing; the base64 PNG beside it is
that same drawing rasterised to 192px, because iOS reads `<link rel="apple-touch-icon">` and
has never accepted SVG there, and an Android launcher that declines to rasterise SVG falls
back to a generated letter tile — which looks like a bug rather than a fallback. 1760 bytes
buys not having to know which builds those are. They can drift; the regeneration command is in
the comment above the base64, and `server.test.ts` at least asserts the bytes are still a
192×192 PNG.

**Every URL in the manifest is relative**, resolved against the manifest's own URL, for the
same reason `api/events` is: a reverse proxy may mount the daemon under a sub-path and an
absolute `/` walks straight out of it. `scope` and `start_url` come out right without the
daemon having to be told where it lives.

One thing deliberately *not* done: `viewport-fit=cover`. It would extend the page under the
status bar and the gesture bar, and while the composer pads for the bottom one, nothing pads
for the top — the clock would land on the chat header. The browser already insets correctly
without it. `page.test.ts` pins the viewport tag so this does not get added by reflex.

## Things that bite

- **Shutdown.** `server.close()` alone never returns: its callback waits for every connection
  to end, and an event stream by definition never does. `stop()` ends the streams itself
  (with a `bye` event, because `EventSource` reconnects after a *clean* close too), then
  `closeIdleConnections` / `close` / `closeAllConnections`, behind a timeout. Get this wrong
  and Ctrl-C hangs the daemon forever, because the signal handler's `process.exit` lives in
  that promise's `finally`.
- **A reverse proxy must not buffer**, and must not strip `Content-Encoding` without
  re-adding it. `proxy_buffering off;` in nginx.
- **`page.ts` is invisible to the toolchain.** Not typechecked, not linted — to TypeScript it is
  a string. So the script is kept stupid, uses string concatenation rather than template literals
  (a literal `` ` `` or `${` would be eaten by the surrounding template and become a module-load
  error), and any change that needs a new *decision* belongs on the other side of the wire. It
  is no longer untested, though: `page.dom.test.ts` runs it in jsdom, and a behavioural change
  in there should arrive with a test, because nothing else in the repo can see it.
- **The page can render nothing while the event stream is perfectly healthy**, and this has
  already shipped once. A client that names no topic sends `GET /api/events` with no `?t=`,
  and `stream()` answers for `topics.current()` — so the sync that comes back carries a topic
  id the page never asked for. Any filter of the form `ev.topic !== topic` therefore drops the
  only sync a first visit will ever get, and the symptom is an empty shell with data visibly
  arriving in the network panel. The client's `topic` is the empty string until a sync or a
  click sets it; a guard against a stale sync has to check that it is set at all first.
- **The narrow-screen breakpoint is stated twice** — the `@media(max-width:640px)` block and
  `NARROW` in the script — because CSS decides the layout and the script decides whether
  picking a topic should then close the drawer. They have to hold the same number. Under it
  the sidebar is a fixed-position drawer over the chat with a backdrop to dismiss it, heights
  are `dvh` so the collapsing URL bar does not push the composer off screen, the composer and
  the token field are 16px so Safari does not zoom in on focus and stay there, the Send row
  clears the home indicator via `env(safe-area-inset-bottom)`, the drawer toggle is padded out
  to a 44px square (a `:not([hidden])` selector, because the rule sets `display` and would
  otherwise beat the UA's `[hidden]` rule while the drawer is open), and the input is not
  focused on open — the keyboard would take half the viewport before a word had been read.
- **Enter sends; under the narrow-screen layout it writes a newline instead.** 1.22.0 made it a
  newline at every width, and the half of that which was right is the phone: held upright there
  is no Shift key to hold, so Enter-to-send makes a multi-line prompt impossible to type rather
  than merely awkward, and a stray Enter costs a half-written one. Neither is true of a keyboard,
  where Shift-Enter is right there and every other chat app on the screen sends on Enter — so
  paying the phone's cost on a desktop bought nothing. `narrow()` is read per keypress, because
  rotating a phone and dragging a window both change the answer. Ctrl/Cmd-Enter sends on both.
- **A reverse proxy must not buffer.** nginx buffers SSE by default; the response carries
  `X-Accel-Buffering: no` and `Cache-Control: no-transform`, but a proxy configured to ignore
  them shows nothing until the turn ends, which reads exactly like a hung daemon. Set
  `proxy_buffering off;`.
- **A restart empties the daemon's ring while the agent still remembers everything.** The
  transcript is memory; the agent's session is persisted by `conversation-store.ts`. So
  `/context` reports real numbers against a room the daemon can no longer replay. The browser's
  own cache now answers most of that (see [above](#the-local-transcript-cache)) — the messages
  come back, above a divider saying where they came from. What it cannot answer is a topic this
  browser has never opened, or one whose cache has rotated out, and those still have to be
  explained rather than rendered as a blank panel: `syncEvent` sets `stale` when a room holds no
  messages and the topic's persisted `lastAt` predates the `WebRoom`, and the page answers it
  with a line saying the topic is older than the daemon and the agent still has its context. It
  also covers the milder case of a topic created before the restart and never spoken in. The
  notice is only shown when there is genuinely nothing on screen — with cached messages up
  there, the divider is the honest version of the same sentence.

## Testing

Everything here is locally exercisable — no live network path, unlike the Satori profiles —
so it is tested rather than verified by hand: `web-markdown.test.ts` (escaping and stream
safety), `auth.test.ts` (constant-time compare, throttle, expiry), `protocol.test.ts` (strict
rejection), `room.test.ts` and `index.test.ts` (the adapter contract), `server.test.ts` (real
sockets: the auth gate, the CSRF locks, the download headers, and that `stop()` terminates
with a stream open), `page.test.ts` (the script parses and nothing was eaten).

`page.dom.test.ts` is the one that covers the client script's *behaviour*. It loads what the
daemon serves into jsdom, stubs `EventSource` and `fetch`, and drives the page through the
events `room.ts` actually emits — asserting on what a person would see: messages on screen, the
drawer open or shut, where the URL points. Add to it whenever you touch `page.ts`; the string
assertions in `page.test.ts` were green throughout the release that rendered nothing.

Three things about it that are not obvious:

- **The stubs are installed in `beforeParse`**, before the inline script runs. Evaluating the
  script a second time to hand it a global would register every listener twice. `indexedDB` is
  one of them — jsdom does not implement it at all, so the harness installs a `fake-indexeddb`
  factory. It can hand the SAME factory to a second page, which is how a reload, and a daemon
  restart under a page that is still open, are driven end to end; passing `idb: null` covers the
  browser that has none.
- **Do not assert CSS through the CSSOM.** jsdom does not evaluate `@media` at all, so
  `getComputedStyle` only ever reports the desktop cascade — and its CSS parser silently drops
  declarations it cannot parse (jsdom 27 discards `calc(… + env(safe-area-inset-bottom))`
  outright) while normalizing selector text, so assertions fail on rules that are perfectly
  correct. The narrow-screen rules are asserted by slicing the `@media` block out of the served
  CSS as text, which also proves they are *inside* it rather than leaking onto the desktop
  layout. The script's own `narrow()` branches do respond to `innerWidth` and are driven
  normally.
- **`jsdom` is pinned to `^27`**, because CI runs Node 20 and jsdom 28+ nests an undici that
  needs a newer one. Read the note in `package.json`'s `comments.pinnedDeps` before bumping it.

The suite is mutation-checked: restoring the sync-guard bug fails eight tests, removing the
backdrop element fails the whole file, and dropping the 16px field rule, the safe-area padding,
the collapsed-drawer offset or the narrow-screen focus guard each fails exactly the test that
names it — including when a rule is *moved out* of the `@media` block rather than deleted.
