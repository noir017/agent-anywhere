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
| `runtime-footer.ts` | The `cc · 18k / 1M (2%) · claude-opus-4-5` tagline |
| `attachment-ingest.ts` | Inbound attachment orchestration (download/save injected) |
| `command-translate.ts` | The generic slash vocabulary and its per-harness translation |
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
  `AbortSignal`. `TurnRunner` reads it to finalize the partial reply cleanly — drop the
  streaming cursor, no footer, no ✅ — and the continuing batch starts a fresh turn that
  produces its own reply and its own reaction. The skip-✅-on-interrupt behavior matters:
  without it a user sees a ✅ on a turn that never finished.
- **Lifecycle reactions**: 👀 received, ✅ done, ❌ error, gated by `reactionsEnabled`
  (`display.reactions.enabled`) independently of the emoji themselves, which stay
  frozen.

## `stream-buffer.ts`

The most subtle file in the module. It turns a token stream into one live-edited chat
message.

- **Dual-trigger throttle**: flush when `charThreshold` (200) chars accumulate **or**
  `flushIntervalMs` (1200 ms) elapses since the last edit. 1200 ms tracks the ~1 edit/sec
  rate limit most IM platforms impose.
- **First push sends** (to obtain a `MessageRef`); later pushes **edit in place**. An
  unchanged text skips the API call entirely.
- **Cursor** trails the live text and is dropped on completion.
- **Backoff and degradation**: on rate-limit the edit interval backs off exponentially
  up to `maxBackoffMs`; after `maxFailuresBeforeFallback` (3) consecutive failures the
  buffer *degrades* to whole-message sends. If the failure that tipped it over happened
  on the final flush, `degradedFinalFlush` drops the frozen partial preview and re-sends
  the full text — otherwise the user is left staring at a truncated message.
- **`noEdit`** starts the buffer already degraded, for platforms with
  `editMessage: false` (QQ, LINE, WeCom, DingTalk). It never sends, edits, or shows a
  cursor mid-stream; it emits the accumulated text as new message(s) on `complete()`,
  which fits those platforms' 1–2 message quota.
- **Chunking** splits overflow without breaking code fences. Critically, it splits the
  **raw** text while the platform limit applies to the **rendered** output — so
  `measureLength` (wired to `PlatformAdapter.measureRendered`) reports the post-render
  length of a raw substring. A Telegram table→bullets rewrite expands ~1.4×; WeCom
  counts UTF-8 bytes, not chars. Without this a chunk overflows after rendering.
- **`[SILENT]`** as the entire reply suppresses all output.

## `tool-renderer.ts`

Renders tool progress as bubbles *separate from the body*: `{emoji} {tool}: "{preview}"`.

Four modes: `off`, `all`, `new` (dedupe consecutive same-name calls), `verbose`
(append full args JSON). Two groupings:

- `separate` — one new message per tool call.
- `accumulate` (default) — edit all progress into **one** bubble, multi-line, refreshed
  in place; `onToolFinish` updates the matching line to `✓/✗ + duration` using the
  event's `index`. Requires `editBubble`; degrades to `separate` when absent.

The renderer owns **only** the bubbles. The message body belongs to `StreamBuffer`.
`TurnRunner` coordinates the handoff: complete the current body buffer, emit the bubble,
then rotate in a fresh body buffer so trailing text becomes a new message instead of
editing the one above the bubble.

## `command-translate.ts`

Read the header comment in the file — it records the bug that motivated the design.

The problem: native platform slash commands are **global** (Telegram `setMyCommands` is
per-bot, Discord per-application), while agents are **per-session**. Registering the
union of what every agent reports produces a menu that cannot say who owns an entry, and
an entry invoked from it routes like any other message — i.e. to `routing.default`, not
to the agent that offered it. Concretely: opencode's `customize-opencode` was landing on
the `claude` agent.

The fix, three layers, all fixed at startup from config alone:

1. Daemon commands (`/new`, `/clear`) — intercepted before any agent.
2. `GENERIC_COMMANDS` — a small fixed vocabulary meaning the same thing everywhere,
   translated to the target harness's native spelling at invocation time.
3. One picker per configured harness (`/claude`, `/opencode`) — the escape hatch to that
   agent's own commands, which are no longer registered globally.

`translateCommand` returns `passthrough` (not generic — forward untouched, power users
can type native names), `translated` (forward as the native name), or `unsupported`
(**refuse with a message, run no turn**). Refusing is the feature: `/compact` on a
harness with no compact is a mistake worth naming, not a prompt worth a turn on.

Provenance of the table is documented per harness and must stay honest: `claude` and
`opencode` were captured live over ACP; `gemini` is unverified; `codex` is deliberately
**empty**, because inventing a native name would send a command the agent may silently
misinterpret — strictly worse than telling the user it is unsupported.

`custom` always passes through — nothing is known about a user-supplied executable, so
rejecting its commands would break a working setup on a guess. `agy` gets no picker: it
reports no command list and runs with `--disable-slash-commands`, so the entry could
only ever be a dead menu item.

## `attachment-ingest.ts`

Pure orchestration; `download` and `save` are injected (the real IO, including the SSRF
guards, lives in [`daemon/attachment-io.ts`](../daemon/README.md)). Platform CDN URLs
expire, so attachments are downloaded and cached. Readable text ≤ `maxInjectBytes`
(100 KB) is inlined into the prompt; anything larger or binary gets a local path for the
agent to `Read` itself. Above `maxDownloadBytes` (25 MB) nothing is fetched and only a
metadata line is emitted.

## `runtime-footer.ts`

Renders the trailing tagline from `FooterField`s, joined by ` · `, empty when no field is
available. `formatTokens` uses the same units the harnesses and Claude Code's own status
line use (`18k`, `324k`, `1.2M`) so numbers are comparable across surfaces. The home
directory is **passed in**, not read — that is the module's purity rule in miniature.

The context fields require the harness to report ACP `usage_update`. A harness that
does not renders no context segment rather than a guessed number.

## Tests

Eight test files, one per non-trivial file. This module carries the repo's only enforced
coverage floor: **70%** statements/branches/functions/lines on `src/core/**`
(`vitest.config.ts`). When you add logic here, add the test — the threshold will fail CI
otherwise, and that is intended.
