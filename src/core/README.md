# `src/core/` — platform-agnostic logic

The pure layer. Every decision here is made from its inputs alone: **no clock, no
`process.env`, no IO, no globals.** Anything time- or IO-dependent is injected
(`now()`, `schedule()`, `download()`, `save()`).

That constraint is the whole point of the module. It means every branch is reachable in
a unit test without mocking the Satori stack or an agent subprocess, and it is why
`core/` sits below `platform/` and `daemon/` in the
[dependency stack](../../AGENTS.md#layering). `core/` imports only `config/schema.ts`
(for types) and `types.ts`.

**Do not add an import of `platform/` or `daemon/` here.** If a piece of logic needs a
platform capability, take it as a parameter or a DI interface — that is how
`StreamBuffer` gets `StreamSink`, `ToolRenderer` gets `BubbleSink`, `InboundMerger` gets
`MergerDeps`, and `ingestAttachments` gets `AttachmentIngestDeps`.

## `conversation.ts` — what "where" means

The type the whole gateway is organized around. A chat platform's location is not always
one id: a Telegram topic and a Slack thread are a `(channel, lane)` **pair**, where the
lane is a separate wire parameter. `ConversationRef` models that as a struct
(`platform` / `channel` / `thread?` / `space?` / `kind` / `user`), and
`ConversationAddress` is the subset an outbound call puts on the wire.

It replaced a composite string (`"<chat>:<topic>"` stuffed into a single `channelId`)
that was built in 5 places, decoded in 17, and validated in none — so any path that
forgot to decode sent to the wrong place, silently in private chats. The string form now
survives at exactly two boundaries, each with one tested formatter and one **validating**
parser: the `--channel` CLI flag and the persisted store key.

`conversationKey(scope, ref)` carries **no agent id**. That absence is deliberate and is
the fix for the reported bug: when the agent led the key, `/oc hi` and the plain message
after it were two conversations in one topic. Who answers is a mutable property *of* a
conversation, not part of its name — see [`daemon/README.md`](../daemon/README.md).

## Files

| File | Role |
|---|---|
| `conversation.ts` | Conversation identity: `ConversationRef` / `ConversationAddress`, the key function, the address parser |
| `inbound-gate.ts` | "Should we respond to this message?" — a pure decision tree |
| `inbound-merger.ts` | Per-conversation state machine: coalesce bursts, queue while busy, interrupt |
| `stream-buffer.ts` | Outbound text: throttled in-place editing, chunking, backoff, degradation |
| `tool-renderer.ts` | Tool-call bubbles: 4 modes × 2 grouping strategies |
| `outbound-pacer.ts` | One write budget per chat: token buckets, one FIFO, in-place edit coalescing |
| `outbound-errors.ts` | The four failure classes the delivery layer needs from the platforms |
| `runtime-footer.ts` | The `cc · 18k / 1M (2%) · claude-opus-4-5` tagline |
| `attachment-ingest.ts` | Inbound attachment orchestration (download/save injected) |
| `command-translate.ts` | The generic slash vocabulary and its per-harness translation |
| `skills-catalog.ts` | `/skills`: the bound agent's own commands as text |
| `settings.ts` | `/setting` as data: which config.yaml fields are editable, what they accept, when a change lands |
| `model-menu.ts` | `/model` as data: paging, labels, button ids, matching, and every string it says |
| `workdir-menu.ts` | `/cd` as data: the same shape, for the directory a conversation works in |
| `paging.ts` | The platform-imposed shape of a button menu: page size, page arithmetic, label budget |
| `button-id.ts` | The `<prefix><reqId>:<n>` button id grammar every menu shares |
| `proxy.ts` | The one impure file — see below |

`proxy.ts` is the deliberate exception: it patches undici's global dispatcher and the
`ws` package so outbound HTTP/WebSocket honor `HTTPS_PROXY`. It reads env and mutates
globals, which no other file here does. It lives in `core/` because `platform/` is its
only consumer and it has no platform-specific content; `redactProxyUrl` (which strips
credentials before logging) is pure and tested.

## `inbound-gate.ts`

`shouldRespond(msg, config, context)` → `{ respond, reason }`. The `reason` string is
stable and asserted in tests and printed in logs — treat it as an interface.

Gating config is **split in two on purpose**:

- The deployment-facing half comes from `platforms.<id>.chat`:
  `requireMention`, `freeResponseChannels`, `ignoredChannels`, `allowBots`.
- The frozen half comes from `EXPERIENCE.inbound.gating`:
  `respondInDirect`, `threadParticipationExempt`.

`ConversationRegistry.gateFor(platformId)` assembles both into one `GateConfig`, per platform
instance. An unknown instance id falls back to "mention required" — the safe default.

Both channel lists are matched with `addressSelects` (`conversation.ts`), not string equality:
an entry naming a chat covers the chat **and its topics**, while `<chat>/<thread>` names one
lane. That is the same rule routing's `when.channelId` has always used, and it is not a
convenience — in a Feishu topic-mode group every message carries a freshly minted topic lane, so
under exact matching the chat id (the only thing an operator can write down) matched nothing:
`channels` silenced the bot in the allowlisted chat, and neither list could reach it.

`GateContext.hasActiveSession` is a proxy for "the bot is already participating in this
thread". The caller must read it **before** creating a merger, or it is always true once
a session exists and the thread-participation exemption is distorted. That ordering
constraint lives in `ConversationRegistry.route`; do not move the read.

## `inbound-merger.ts`

One instance per session. A three-phase state machine:

```
idle ──ingest──► collecting ──window elapsed──► running ──turn ends──► idle
                      ▲                            │
                      └──── queued batch ◄─────────┘  (messages arriving mid-turn)
```

- **Collecting**: a sliding merge window (`mergeWindowMs`, default 1.5 s) coalesces
  rapid consecutive messages into one turn, capped by `maxMergeWindowMs` (5 s) so a
  steady typist cannot starve the turn forever.
- **Running**: new messages go to a single-slot queue holding the **latest batch** —
  never dropped, never unbounded.
- **Interrupt** (`interruptOnNewMessage`, default true): a new message trips the turn's
  `AbortSignal`. `TurnRunner` reads it to finalize the partial reply cleanly — no footer,
  no ✅ — and the continuing batch starts a fresh turn that
  produces its own reply and its own reaction. The skip-✅-on-interrupt behavior matters:
  without it a user sees a ✅ on a turn that never finished.
- **Lifecycle reactions**: 👀 received, ✅ done, ❌ error, gated by `reactionsEnabled`
  (`display.reactions.enabled`) independently of the emoji themselves, which stay
  frozen.

## `stream-buffer.ts`

The most subtle file in the module. It buffers one turn's reply text and delivers it,
in one of two modes.

### `'once'` — the default (`stream.enabled: false`)

```
push … push … complete({footer}) ─▶ [ message ][ message ]…
```

Nothing goes out until the buffer completes; then the accumulated text is split by
`maxMessageLength` and sent as one message, or several. No message is ever edited.

This is the default because live editing costs more than it returns. Every flush spends an
edit and platforms cap them per message — Feishu allows 20 and then refuses *that message*
forever — so the reply most likely to run out of edits mid-delivery is the long, considered
one that matters most. Finished text sent once has no such ceiling: the only limit left is
message length, which splits cleanly.

The turn is not silent in the meantime. `TurnRunner` completes the body buffer at every
tool boundary and rotates in a fresh one, so a turn that uses tools reports as it goes —
each finished text segment arrives as its own message, alongside the session header bubble,
the 👀 reaction, and the tool bubbles (which *do* refresh in place).

### `'live'` (`stream.enabled: true`)

```
[ sealed ][ sealed ][ open ]
                       ↑ still edited in place as text arrives
```

Dual-trigger throttle: flush when `charThreshold` (200) chars accumulate **or**
`flushIntervalMs` (1200 ms) elapses since the last write. 1200 ms tracks the ~1 edit/sec
rate limit most IM platforms impose. Requires `capabilities.editMessage`, so the daemon
resolves the mode from `stream.enabled` **and** the capability: a platform that cannot edit
(QQ, LINE, WeCom, DingTalk) always gets `'once'`, which also fits its 1–2 message quota.

### Sealing (both modes)

A message is **sealed** — immutable, never touched again — for one of three reasons, all
handled identically:

| reason | trigger |
|---|---|
| full | the text outgrew `maxMessageLength` |
| budget spent | `maxEditsPerMessage` in-place edits used up |
| not editable | the platform rejected an edit with `MessageNotEditableError` |

Sealing is never a failure: the sealed text counts as delivered and delivery continues into
a fresh message, so `sealedText + open.text` is always exactly what the user can see.
Nothing is re-sent, nothing is lost. In `'once'` mode only the first reason can occur, which
is why that mode cannot lose the tail of a reply at all.

Folding the edit budget into the same concept as the length limit is what makes that
invariant hold — both are just *"this message can take no more"*. The previous design had
only "back off, then degrade to whole-message send", which could not express *permanently
un-editable*: past Lark's cap the final flush re-edited the dead message, swallowed the
rejection, and reported the turn complete. Everything after the cap was lost, and the user
saw a reply truncated mid-sentence with a ✅ on it.

- **First write sends** (to obtain a `MessageRef`); later writes **edit in place**. Text
  already on screen verbatim skips the API call — and, importantly, does not spend budget.
- **Transient failures** (rate limit, network) back the interval off exponentially up to
  `maxBackoffMs` and keep the message open. Only the platform can say a failure is
  permanent, which is what `MessageNotEditableError` is for (see `outbound-errors.ts`).
  When the platform states a **number** (`RateLimitedError.retryAfterMs`), that number wins
  over `maxBackoffMs`: the cap is a guess about how long a limit lasts, and Telegram has
  been observed asking for 229 s against a 10 s default. The backoff holds back **both**
  triggers, not just the timer — gating only the timer left the char threshold as an open
  door, so a stream that kept producing text retried every `charThreshold` characters
  straight through the wait and deepened the limit instead of letting it expire.
- **The final flush never gives up**: with no later flush to recover, any failure it can
  route around is routed around — it seals the open message and sends the remainder rather
  than leaving the answer truncated.
- **Chunking** splits overflow without breaking code fences. Critically, it splits the
  **raw** text while the platform limit applies to the **rendered** output — so
  `measureLength` (wired to `PlatformAdapter.measureRendered`) reports the post-render
  length of a raw substring. A Telegram table→bullets rewrite expands ~1.4×; WeCom
  counts UTF-8 bytes, not chars. Without this a chunk overflows after rendering.
- **`[SILENT]`** as the entire reply suppresses all output.

## `outbound-errors.ts`

The vocabulary the delivery layer needs from the platforms. It started as two words and is
now four, because two turned out to hide two different distinctions:

| class | meaning | what the writer does |
|---|---|---|
| *(untyped)* | transient, unquantified — 5xx, socket reset | back off blindly, keep the message |
| `MessageNotEditableError` | permanent, **message**-scoped | seal it, continue in a new message |
| `RateLimitedError` | transient, **chat**-scoped, and *quantified* | wait exactly `retryAfterMs` |
| `WriteDroppedError` | never attempted — the pacer discarded it | state is untouched; write again |

Profiles translate their own codes through `PlatformProfile.classifyError`: Lark maps
`230072`, Telegram maps `429` (and recovers `retry after N` from the message text, because
satori's adapter throws away `parameters.retry_after` — see the contract test). Everything
else stays untyped on purpose, so a rate limit never fragments a reply into extra messages.

`retryAfterMsOf(e)` reads the stated wait, walking `AggregateError.errors` for it — the
profile's typed error can reach the writer as a *child* rather than as the thrown value.

Also home to `describeOutboundError`, which walks the same tree — satori's
MessageEncoder throws an AggregateError whose own `.message` is empty, so logging
`e.message` yielded a blank reason and failing tool bubbles logged as
`[turn] render side effect failed: ` with nothing after the colon.

## Sealing vs. pacing

The two concepts most easily confused, and conflating them is exactly the mistake the old
`ToolRenderer.paint()` encoded when it rethrew a 429:

|  | **sealing** | **pacing** |
|---|---|---|
| scope | one message | one chat |
| duration | permanent | temporary |
| question | "can this message take more?" | "can this chat take more *right now*?" |
| answer | continue in a NEW message | wait, then send the SAME thing |
| lives in | `stream-buffer.ts` / `tool-renderer.ts` | `outbound-pacer.ts` |

The three sealing rules stay three. Pacing is not a fourth: a rate limit never means a
message is finished, and treating it that way either fragments a reply into extra messages
or — the bug that was actually shipped — drops the write entirely.

## `outbound-pacer.ts`

One write budget per chat, shared by *everything*: the reply, the tool bubbles, the
reactions, the acks, the menus, and the agent's own reverse commands. The platform counts
them as a single stream, so a per-writer throttle cannot bound them no matter how it is
tuned — the quantity being limited is a sum, and no summand can see it. That is how a
`StreamBuffer` politely throttled to 1 edit/1200 ms and a `ToolRenderer` with no throttle at
all combined into 78 × `429 Too Many Requests` in one daemon run, `retry after` reaching
229 seconds.

```
submit(job) ─▶ [ per-chat FIFO ] ─▶ bucket (chat) ─▶ bucket (instance) ─▶ run()
                     │
                     └─ a queued EDIT is replaced in place by a newer edit to the same message
```

- **Keyed on `<platformInstance>:<channel>`, never the thread.** A Telegram forum topic
  shares its parent chat's flood budget; keying by lane would hand every topic a full
  allowance and reproduce the flood one level down.
- **Token bucket, not a fixed interval.** An idle chat writes immediately; a busy one
  paces. `burst` is sized so a whole ordinary turn goes out with no delay at all and only
  sustained traffic is metered — the failure this exists to prevent was hundreds of writes,
  not a dozen.
- **Coalescing needs no API.** An edit is a statement about a message's final content, so
  two queued edits to one message collapse to the newer; a send creates a new object whose
  ref the caller needs back, so a send is never coalesced. The replacement keeps the queue
  **position** the older version earned, which is what keeps a bubble above the text
  submitted after it.
- **Only some writes may be dropped.** `reply` never is, however long the lane is stuck.
  `progress` (tool bubbles) is dropped when superseded or stale — the next paint carries
  the current state, and a bubble showing where the agent was eight seconds ago is worse
  than one that skips ahead. `typing` is dropped the moment it cannot go out immediately.
- **A drop is reported, never swallowed.** `WriteDroppedError` leaves the caller's state
  untouched, which is what makes "a progress update is never lost" structural rather than
  lucky.

The pacer is pure; `daemon/paced-adapter.ts` applies it to every `PlatformAdapter` method
and is the one place a `RateLimitedError` becomes a lane pause.

## `tool-renderer.ts`

Renders tool progress as bubbles *separate from the body*: `{emoji} {tool}: "{preview}"`.

Four modes: `off`, `all`, `new` (dedupe consecutive same-name calls), `verbose`
(append full args JSON). Two groupings:

- `separate` — one new message per tool call.
- `accumulate` (default) — edit all progress into **one** bubble, multi-line, refreshed
  in place; `onToolFinish` updates the matching line to `✓/✗ + duration` using the
  event's `index`. Requires `editBubble`; degrades to `separate` when absent.

`accumulate` spends one edit per update, so a ten-tool turn is 20 edits — exactly Lark's
cap. The bubble is therefore **sealed** on the same three rules as a message in
`StreamBuffer` — budget spent, full, not editable: stop editing it, carry the lines whose
state it does not already show (still running, or finished since the last write) into a
fresh bubble, and keep going. Lines already fully rendered are dropped rather than
repeated, so bubbles don't grow by the whole history.

The "full" rule is why `maxMessageLength` and `measureLength` are wired in alongside
`maxEdits`. Without them a busy turn grew one bubble until the platform refused the write
outright — Telegram answers `MESSAGE_TOO_LONG` to the edit and `text is too long` to the
send — and because neither is a `MessageNotEditableError`, `paint()` rethrew and the whole
block of progress was dropped with only a `[turn] render side effect failed:` line to show
for it. When the surviving lines *alone* still overflow (a burst of parallel tools, none
finished), the oldest go first: they are the ones already readable in the sealed bubble
above. A single line over the limit — a verbose-mode JSON dump — is clamped, because
delivering part of it beats having the platform reject all of it.

The renderer owns **only** the bubbles. The message body belongs to `StreamBuffer`.
`TurnRunner` coordinates the handoff: complete the current body buffer, emit the bubble,
then rotate in a fresh body buffer so trailing text becomes a new message instead of
editing the one above the bubble.

### Painting is asynchronous, and a failed write is never lost

Sealing answers "this bubble can take no more". It does not answer "this **chat** can take
no more right now", and the renderer used to have no answer for that at all: it repainted
synchronously on every tool start *and* every finish, with no throttle, and rethrew
anything that was not a `MessageNotEditableError`. Under a run of back-to-back tool calls
that is two writes per tool into one chat. Telegram answered `429`, the rethrow reached the
turn's side-effect chain, and the update was gone — nothing re-triggers a paint until the
next tool event, so the bubble sat frozen on stale progress for minutes.

So `onToolStart` / `onToolFinish` are now `void`: they mutate the line set and return, and a
single painter drains it. Three consequences worth knowing:

- **Nothing blocks the reply.** Painting is off `TurnRunner`'s side-effect chain, so a
  paused lane cannot stall the body text behind a progress bubble. `finalize` calls
  `settle(finalizeWaitMs)`, which stops *waiting* without *cancelling* — a queued write
  still lands, just after the ✅.
- **Every failure that is not a seal arms a retry**, at the platform's own `retryAfterMs`
  when it named one, else an exponential backoff. A write the pacer discarded
  (`WriteDroppedError`) is treated identically: not delivered, therefore still pending.
- **Delivery is a revision watermark, not a flag.** `deliveredRev` is the highest revision
  of the line set that actually reached the platform. A `finishDelivered` boolean was
  correct only while writes were synchronous: a ✓ recorded *while* a paint is in flight is
  not delivered by that paint, and marking it so would let the next seal drop a line the
  user never saw finish. For the same reason `resetSegment()` defers its clear until the
  segment's final state has landed.

`onToolStart` used to return "did a new bubble appear", documented as driving the segment
break. `TurnRunner` never read it, and it cannot be answered synchronously now. It is gone.

## `command-translate.ts`

Read the header comment in the file — it records the bug that motivated the design.

The problem: native platform slash commands are **global** (Telegram `setMyCommands` is
per-bot, Discord per-application), while agents are **per-session**. Registering the
union of what every agent reports produces a menu that cannot say who owns an entry, and
an entry invoked from it routes like any other message — i.e. to `routing.default`, not
to the agent that offered it. Concretely: opencode's `customize-opencode` was landing on
the `claude` agent.

The fix, three layers, all fixed at startup from config alone:

1. `DAEMON_COMMANDS` (`/new`, `/clear`, `/stop`, `/setting`, `/help`) — intercepted before any
   agent. `/new` and `/stop` are separate because they answer separate asks: both end the running
   turn, only `/new` also ends the conversation. `/setting` is the odd one out — it is the only
   command whose effect outlives the conversation, because it writes config.yaml (see
   [`settings.ts`](#settingsts)).
2. `GENERIC_COMMANDS` — a small fixed vocabulary meaning the same thing everywhere,
   translated to the target harness's native spelling at invocation time.
3. `HARNESS_COMMANDS` — one agent command per configured harness (`/cc`, `/oc`, `/agy`).
   `/oc <prompt>` switches the conversation and asks; bare `/oc` switches and offers that
   agent's own commands, which are the ones not registered globally.

`translateCommand` returns `passthrough` (not generic — forward untouched, power users
can type native names), `translated` (forward as the native name), `local` (**the daemon
answers it, no turn** — see below), or `unsupported` (**refuse with a message, run no
turn**). Refusing is the feature: `/compact` on a harness with no compact is a mistake
worth naming, not a prompt worth a turn on.

Provenance of the table is documented per harness and must stay honest: `claude` and
`opencode` were captured live over ACP; `gemini` is unverified; `codex` is deliberately
**empty**, because inventing a native name would send a command the agent may silently
misinterpret — strictly worse than telling the user it is unsupported.

### The `local` fallback

The table's only mechanism is TEXT: it rewrites `/x` and hands it to the agent as a
prompt. So a capability the harness exposes over the **protocol** rather than as a slash
command has no native name to translate to, and used to read as "not supported" — even
though the gateway could answer it outright. Two do:

| command | why there is no native name to translate to | what answers it |
|---|---|---|
| `/context` (opencode) | opencode's `/compact`-family commands are TUI-only; ACP mode never sees them | the last `usage_update {used, size}` the agent sent, the same numbers the footer prints |
| `/model` (opencode, claude, agy) | opencode and claude expose the selector as a config option; agy reads it from `agy models` and switches via kill-and-respawn with `--model` and `--conversation` | `ConversationRegistry.applyModelCommand` via `AgentSession.modelSelector()` / `setModel()` |

`/model` has two surfaces, both built from `model-menu.ts` so they cannot disagree about
what happened. On a platform that can post buttons **and** edit them afterwards, a bare
`/model` opens a paginated menu — on the page holding the current model, since "what am I
on" is half the question. Everywhere else it prints the summary line it always did.
`/model <part of a name>` stays a pure text path on all eight platforms.

Both surfaces go through `ConversationRegistry.warmModelSelector`, which **starts the session**
when there is no list yet. Under ACP the list arrives in the `session/new` response, so a
conversation that has not run a turn has none — and the old answer, "No model selector on this
session yet, send a message then /model", was wrong in the flow it broke most: the `/cd` menu
invites picking a project and then a model, and `/cd` disposes the session, so even an established
conversation lost its list. Starting a child to answer the question brings forward the one the next
message would have started anyway; nothing is prompted and no context is spent. A failure to start
reports its real reason (`modelStartFailedText`), and `modelNoSelectorText` now means what it says:
this harness offers no model choice at all.

`/setting`'s model row deliberately does NOT warm — it reads through `peek`. Warming there would
spawn a child to answer `/setting banana`, and warming at the button click instead would mean making
the daemon's synchronous settings-menu path async.

`modelMenuSurface()` requires both capabilities, and the second is the interesting one: on
a platform that cannot edit (LINE, QQ) a menu could never be paged and — worse — never
retired, so after a pick its buttons would sit live above the ack answering "expired"
forever. A text answer there is not a degraded menu; it is the whole answer.

Two rules keep this honest:

- **A native spelling wins.** `/context` on claude still reaches claude's own `/context`,
  which knows more about claude than this gateway does. The fallback fills a hole; it
  never covers a harness that solved the problem itself. `/model` on claude looks like an
  exception and is not: probed live, the adapter does not advertise `model` at all, so a
  forwarded `/model` is a plain prompt — it spends a turn and prints
  `Current model: … Usage: /model <name>`, i.e. text to type against — while the same
  session exposes the selector as a config option the daemon can switch in one tap. The
  cost is that only the options the protocol lists can be chosen; claude's prose names
  more aliases (`opusplan`, `best`, a full model id), which stay reachable through
  `agents[].env.ANTHROPIC_MODEL`.
- **`local` is a harness LIST, not a flag**, populated only from what was probed live.
  `agy` speaks no ACP — it reports no usage numbers — so claiming a local
  answer for `/context` there would hand the user "no numbers yet, send a message first" forever. An
  honest "not supported" beats an answer that never arrives.

`/model` matches on any substring that picks exactly one model, because opencode offers
93 of them: far past a button menu's 25 and past what is readable as a list, but
`/model sonnet-5` is one thumb-typed token. An ambiguous query lists the candidates
rather than guessing — picking one silently would change which model answers.

`custom` always passes through — nothing is known about a user-supplied executable, so
rejecting its commands would break a working setup on a guess.

### `HARNESS_COMMANDS`

The single source for what each harness's command is called, which spellings resolve to
it, and whether a bare invocation can show a menu.

| harness | registered | also accepts | bare form |
|---|---|---|---|
| `claude` | `/cc` | `/claude` | its command menu |
| `opencode` | `/oc` | `/opencode` | its command menu |
| `codex` | `/cx` | `/codex` | its command menu |
| `gemini` | `/gm` | `/gemini` | its command menu |
| `agy` | `/agy` | — | binding ack |
| `custom` | — | — | — |

Short names because these are typed on a phone, mid-conversation, many times a day;
`/opencode` was the harness enum value leaking into the UI. The full harness name stays
as an unregistered alias so existing muscle memory and any `when: { command: opencode }`
already in a config keep working — it simply costs no slot in the platform menu.

**`name` and `picker` are separate fields on purpose.** Registering a command and having
a command list to show are different questions, and `agy` is the case that proves it: it
reports no command list and runs with `--disable-slash-commands`, so a bare `/agy` could
only ever say "none yet" — but switching a conversation *to* agy is the useful half, and
skipping registration entirely left the one harness a user most needs to reach by name
with no menu entry at all. `custom` is absent from both: the harness name carries no
meaning to a reader and the executable advertises no stable command set.

`agentForCommand` resolves a command to the **first configured agent of that harness**,
which is what lets a registered command work with no `routing.pipeline` entry. Before
this, `/oc` meant something only because an operator had hand-written
`when: { command: oc }`, so a fresh install registered a menu whose agent commands were
inert and reached the bound agent as the literal text `/oc`. A pipeline rule still
outranks the table — see `daemon/routing.ts` `resolveAgent`.

`unconfiguredHarnessCommand` is the other side of that lookup: a name that IS in the
vocabulary but selects nothing here, because this deployment configures no agent of that
harness. `daemon/conversation.ts` answers it instead of forwarding — a declined name keeps
its `/agy` prefix, so the bound agent would run it as one of its own slash commands, find
nothing, and produce no output at all.

`buildHelpText` renders `/help` from these same tables, so a command cannot reach the
platform menu without reaching the help text. It filters the generic section to what the
*currently bound* harness actually supports, because listing `/compact` to an opencode
user who will be told "not supported" the moment they tap it is precisely the silent
degradation this project avoids.

## `settings.ts`

`/setting` as data. One `SETTINGS`-style table drives the menu rows, the text list, value
validation, the config path that gets patched, and the ack sentence — so a settings screen
cannot list a field it will not write, or write one it never listed.

The editable set is deliberately narrow (`model` expands to one row per configured agent):

| key | config path | accepts | takes effect |
|---|---|---|---|
| `agent` | `routing.default` | a configured agent id | **now** — `resolveAgent` re-reads it per message |
| `model` / `model.<agent>` | `agents[<id>].model` | the agent's reported list, any name, or `-` to clear | **next agent session** — the value is read at spawn |
| `idle` | `session.idleTimeoutMs` | `off`, `<n>m`, `<n>h` | **now** — the sweeper is re-armed |
| `scope` | `session.scope` | the four `SessionScope` values | **on restart** — file only |
| `stream` | `stream.enabled` | `on` / `off` | **now** — `TurnRunner` resolves the delivery mode per turn |

`scope` is the one that is written but not applied, and that is the interesting decision.
The scope decides how `conversationKey` is computed, so changing it live would silently
re-identify every existing conversation: the next message in a topic would land in a brand
new one with no context, while the old agent child sat resident until reclaim. Writing the
durable answer and saying "on restart" is the honest version.

`model` is the only per-target setting, and its option list has a condition worth
remembering: a model list exists only on a **live ACP session**, and a conversation has at
most one — so buttons are offered for the agent answering *here*, and any other agent's
model is set by typing the name. The empty case gets a sentence naming which condition is
missing (`settingTypedOnlyHint`), never a blank menu. An unrecognized name is **accepted**
rather than refused: the selector is not the set of names a harness takes (claude documents
`opusplan`, `best`, a full model id, none of which the ACP config option lists), so the ack
says it was not advertised instead.

What is **not** editable is refused *by name* (`NOT_EDITABLE`), with the reason, rather than
answered "no such setting" — a real config key deserves better than being told it does not
exist. `access.allowFrom` is out because one wrong value locks the operator out of the
surface they would use to fix it; credentials because a chat log is the wrong place for
them; `routing.pipeline` because a rule is a structure, not a value a picker can offer; and
the `EXPERIENCE` knobs because they are not in the file at all.

The write half lives in [`daemon/settings-store.ts`](../daemon/README.md) — this module
decides, that one touches the file.

## `skills-catalog.ts`

Backs `/skills`. Read the header comment in the file — it records why this is text and not a
picker.

The short version: a picker was the obvious design and does not fit. claude reports 65
commands here, Discord caps an interactive message at 25 buttons, and buttons cannot carry
free text — so a tapped one would have to park a pending selection and wait for the next
message to complete it, buying a state machine and an expiry policy. None of that is needed,
because typing `/server-ops check the disk` already reaches the agent: a name outside the
generic vocabulary passes through untouched (`ConversationRegistry.route`). Invocation was
never the gap; discovery was, and a list answers it in one message.

The catalogue is **everything the agent reported**, minus what the registered menu already
covers, in reported order (claude lists skills first, built-ins last, and that grouping beats
sorting). It is not narrowed to skills because nothing on the wire says which is which:
`available_commands_update` carries only `{name, description, input}`. The skill directories
cannot substitute either — claude reads a tree of symlinks, opencode reads a different tree
named in its own config, and the sets differ — so the harness's own report is the only
authority.

Names only, no per-command descriptions: 58 entries render to ~1.2 kB, inside Discord's 2000,
while adding prose pushes the same list past 4 kB and would force either truncation or a
multi-message reply every time. The daemon still chunks the result, for a harness with more or
longer names than any seen so far.

## `paging.ts`

Page size, page arithmetic and the label budget, shared by the `/model` and `/setting`
menus. Both are bounded by the same platform facts: Discord allows 25 components per
message, and Telegram's profile puts one button per row, so a page costs `size + 2` rows on
a phone. Page navigation **wraps** rather than disappearing at the edges — hiding ◀ on the
first page shifts every other button by one position between pages, and a disabled button
does not exist on Telegram at all.

## `attachment-ingest.ts`

Pure orchestration; `download` and `save` are injected (the real IO, including the SSRF
guards, lives in [`daemon/attachment-io.ts`](../daemon/README.md)). Platform CDN URLs
expire, so attachments are downloaded and cached. Readable text ≤ `maxInjectBytes`
(100 KB) is inlined into the prompt; anything larger or binary gets a local path for the
agent to `Read` itself. Above `maxDownloadBytes` (25 MB) nothing is fetched and only a
metadata line is emitted.

`download` may report a `name` and a `contentType` alongside the bytes, and both are
**fallbacks** — what the message element declared wins. They exist because the platforms whose
media needs a platform-specific fetch (Lark) are exactly the ones whose elements declare
neither, so the fetch is the only place either can be learned: a Feishu image has no filename at
all. Learning them late changes two decisions, which is why they are not merely logged — what
the saved file is called, and whether this was readable text after all.

## `runtime-footer.ts`

Renders the trailing tagline from `FooterField`s, joined by ` · `, empty when no field is
available. `formatTokens` uses the same units the harnesses and Claude Code's own status
line use (`18k`, `324k`, `1.2M`) so numbers are comparable across surfaces. The home
directory is **passed in**, not read — that is the module's purity rule in miniature.

The context fields require the harness to report ACP `usage_update`. A harness that
does not renders no context segment rather than a guessed number.

## Tests

One test file per non-trivial file here. This module carries the repo's only enforced
coverage floor: **70%** statements/branches/functions/lines on `src/core/**`
(`vitest.config.ts`). When you add logic here, add the test — the threshold will fail CI
otherwise, and that is intended.
