# `src/daemon/` — the running system

The only module allowed to depend on every other one. It owns routing, session
lifetime, turn orchestration, and the agent runtimes.

## Files

| File | Role |
|---|---|
| `daemon.ts` | Top-level wiring: platforms + session registry + IPC. Slash registration, `ask` buttons, harness pickers. |
| `routing.ts` | Pure: inbound → `{ agentId, scope }` → session key |
| `session.ts` | `SessionRegistry` — per-session state, access + gating, command translation |
| `turn-runner.ts` | One turn end to end: prompt, streaming, tools, footer, errors |
| `agent.ts` | `AgentFactory` / `AgentSession` / `AgentStreamHandlers` interfaces. Dependency-free. |
| `agent-factory.ts` | Dispatch: which runtime serves which agent |
| `agent-acp.ts` | ACP runtime (claude, codex, opencode, gemini, custom) |
| `agent-agy.ts` | Antigravity CLI runtime — its own stream-json protocol |
| `agent-common.ts` | Protocol-agnostic helpers shared by both runtimes |
| `session-store.ts` | Persistent session-key → agent-session-id map |
| `session-token-registry.ts` | Per-session reverse-command token ↔ session id |
| `attachment-io.ts` | Real attachment IO + the SSRF guards |
| `reverse-cli-shim.ts` | Guarantees `agent-anywhere` is on the agent's PATH |

## Inbound flow

```
adapter.onMessage
   │
   ▼
Daemon.onInbound ─── cross-event dedup (platform:channel:message, 15 s TTL)
   │
   ▼
SessionRegistry.route
   ├─ access gate        access.allowFrom — `platform:userId`
   ├─ resolveRoute       routing.pipeline, first match wins → agentId + scope
   ├─ sessionKey         scope + agentId → the session id
   ├─ bare-command ack   `/codex` alone → usage reply, no turn
   ├─ /new · /clear      reset session, drop the persisted id, ack. Never forwarded.
   ├─ response gate      core/inbound-gate shouldRespond
   ├─ command translate  generic → native, or refuse; harness picker
   ├─ header bubble      once per session, on receipt
   ▼
InboundMerger.ingest ── merge window / queue / interrupt
   ▼
TurnRunner.runTurn
```

Several orderings in `route()` are load-bearing and commented in place:

- **`hasActiveSession` is read before any merger is built** — otherwise it is always
  true once a session exists and the thread-participation exemption is distorted.
- **Gating runs on the original content**, not the prefix-stripped one. A bare `/oc`
  strips to empty and would trip the empty-message gate, losing the usage ack. The gate
  rejects messages that *arrived* empty (a native slash command's phantom message), not
  ones `route` just emptied.
- **Command translation sits after session creation**: it is the first point that knows
  *which* agent will answer, and the last point at which the message can still be
  refused.
- **The header is sent after every gate**, so it cannot become a probe — a message that
  will not be answered gets no acknowledgement of any kind.
- **`/new` is intercepted before the merger**, so it works mid-turn (dispose aborts the
  in-flight turn).

## Routing and session keys

`resolveRoute` walks `routing.pipeline` in order; the first rule whose `when` **fully**
matches wins, else `routing.default`. Match fields: `platform` (instance id),
`serverId`, `channelId`, `userId`, `chat` (private/group/thread), `isBot`, `command`.

`when.command` matches the leading `/name` of **plain message text**, so command routing
works on every platform regardless of native slash support — `Daemon.onCommand`
synthesizes native invocations into `/name input` text, so one code path covers both. A
rule that matches via `command` sets `consumedCommand`, and the caller **must** strip
the prefix so the target agent does not try to interpret it as one of its own commands.

Session keys are qualified by agent id:

```
shared       → <agentId>:shared
per_user     → <agentId>:<platform>:u:<userId>
per_channel  → <agentId>:<platform>:c:<channelId>     (default)
per_thread   → <agentId>:<platform>:t:<channelId>
```

The agent qualifier matters: without it, two agents addressed in the same place (`/codex …`
next to default-agent chat in one channel) would collide, and whichever was created
first would capture the key forever.

## Session lifetime

**Sessions live for the daemon's lifetime.** There is deliberately no automatic
reclamation — evicting a session would silently drop conversation context and kill a
resident subprocess, and the live-session set is naturally bounded by `access.allowFrom`
in any sane deployment. A session ends when the daemon stops or the user sends `/new`.

`SessionState` is one object per session (previously parallel `Map`s). Creation sets it
in one assignment (no half-init), release is one `sessions.delete` (no leak), and adding
a per-session field touches only that interface. The stable token is the exception — it
lives in `SessionTokenRegistry`, since token bookkeeping is a separate concern from
turn orchestration.

Context survives restarts via `SessionStore` (`<configDir>/sessions.json`): a
write-through session-key → agent-session-id map. The harness keeps the actual history
on its own disk; this only remembers *which* session belongs to each key, so a restarted
daemon can `session/load` it (ACP) or pass `--conversation` (agy) instead of starting
blank. A missing or corrupt file degrades to empty — context loss, not a crash. `/new`
deletes the entry, otherwise the context would resurrect on the next restart.

## `TurnRunner`

One turn, end to end. It receives a narrow DI interface (`TurnRunnerDeps`) rather than
the whole `SessionRegistry`, to avoid bidirectional coupling: the registry stays the sole
owner of state and lifecycle, and the runner borrows read-only views (`agentIdOf`,
`tokenFor`, `getModelOverride`) plus one write entry (`setActiveChannel`).

Per turn it: resolves the platform instance from the batch (a shared-scope session may
hop instances between turns, so this is per-turn, not per-session) → resolves the channel
(creating a thread first when `autoThread: perTurn`, so the whole turn lands in it) →
starts a typing keep-alive loop (Discord's indicator self-expires ~10 s) → builds a
`StreamBuffer` factory and a `ToolRenderer` → runs the agent turn → final-flushes with
the footer.

Two mechanisms worth understanding before editing:

**The effects chain.** All stream-event side effects are serialized into one promise
chain (`enqueue`), so "text push → tool-boundary flush → tool bubble → trailing text"
execute in strict arrival order with no interleaving. Failures are swallowed into the
chain — rendering is best-effort — rather than escaping as unhandled rejections.

**`TurnRef`.** The stream callbacks are extracted into `buildStreamHandlers`, so the
"current buffer" and "did we produce output" cannot be bare `let`s (a mutable binding is
not shared across that function boundary). They live in one mutable object read and
written by both ends. Never cache `ref.stream` — it is rotated at segment boundaries.

Turn outcomes:

- **Normal**: final flush with the footer.
- **Interrupted** (`signal.aborted`): finalize the partial reply cleanly — drop the
  cursor, no footer, no ✅, skip the command fallback. The continuing batch produces its
  own reply.
- **Failed**: log the stack, send a capped (300 char) `❌ This turn failed: <reason>`
  in-channel, then rethrow for the merger to mark ❌. The reason is surfaced because the
  runtime error messages (`auth_required`, startup/turn timeout, command not on PATH) are
  written to be user-actionable — a bare ❌ reaction wastes them.
- **Command with zero output**: some harness built-ins (`/compact`) produce a
  marker-only shell that the harness strips to nothing, leaving the chat silent. A
  fallback note is sent instead.

The **per-turn silence watchdog** (`session.turnTimeoutMs`, 10 min) bounds *silence*,
not total turn length — the timer resets on every agent update. On trip the subprocess is
force-disposed and the turn fails.

## Agent runtimes

```
                    AgentFactory  (agent.ts — interface, imports nothing)
                          ▲
                createAgentFactory  (agent-factory.ts — dispatch by harness)
                    ┌─────┴─────┐
              agent-acp.ts   agent-agy.ts
        claude/codex/opencode/     agy
          gemini/custom
```

Everything above this boundary — `SessionRegistry`, `TurnRunner`, `StreamBuffer`,
`ToolRenderer` — is **protocol-agnostic** and reused unchanged by both runtimes. Keep it
that way: a new protocol means a new sibling runtime implementing `AgentFactory`, not a
branch upstream.

`agent.ts` holds only interfaces and imports nothing from the project — both runtimes
import it, so putting the dispatch there would create a cycle. That is why
`agent-factory.ts` is its own file.

`dispose(sessionId)` fans out to both runtimes rather than tracking ownership: callers
hold only a session key, and disposing a session a runtime never created is a documented
no-op.

### `agent-acp.ts` — the ACP runtime

The daemon is the ACP **client/host**. Each `(sessionId, agentId)` spawns a resident ACP
agent child, and `session/update` notifications are translated back into
`AgentStreamHandlers`:

| ACP | → |
|---|---|
| `session/new` / `session/load` | an `AgentSession` (context across turns) |
| `session/prompt` | `runTurn` |
| `agent_message_chunk` | `onText` |
| `tool_call` / `tool_call_update` | `onToolStart` / `onToolFinish` |
| `available_commands_update` | `onAvailableCommands` |
| `usage_update` | `onUsage` (feeds the footer's context segment) |
| `config_option_update` | `onModel` |
| `session/request_permission` | **auto-approved** — see below |

`claude` and `codex` adapters are **bundled** as dependencies and resolved via
`resolveClaudeAdapterEntry` / `resolveCodexAdapterEntry`, so neither needs a separate
install. `opencode` and `custom` are located on PATH.

> **The daemon auto-approves every tool permission request.** Agents run with full tool
> access. There is no per-call policy in the config schema by design — tightening tool
> permissions is delegated to the harness itself via that agent's `args`/`env`. The
> daemon's only access control is `access.allowFrom`. See
> [security invariants](../../AGENTS.md#security-invariants).

`onModel` reports what the harness says is actually serving the session, which is more
accurate than the config: the `claude` harness takes its model from `ANTHROPIC_MODEL` and
resolves aliases like `opus[1m]` internally. Header = what was asked for; footer = what
ran.

### `agent-agy.ts` — the Antigravity runtime

Read the file header before touching this. `agy` **does not speak ACP** — it has no ACP
mode at all. A community adapter (`agy-acp`) exists but drives agy through a PTY, reads
its internal SQLite/protobuf records, and **deadlocks permanently on the turn following
any tool call** — fatal for a chat gateway, where the bot would go silent forever after
its first real task. So this runtime speaks agy's own documented headless stream-json
protocol directly.

Protocol mapping (verified empirically against agy 1.1.22):

| agy | → |
|---|---|
| one resident child | an `AgentSession` |
| `{"event":"user","message":…}` written to stdin | `runTurn` |
| `step_update.text_delta` | `onText` (deltas, not cumulative) |
| `step_type:"tool"` ACTIVE / DONE | `onToolStart` / `onToolFinish` |
| text↔tool boundary | `onSegmentBreak` |
| `event:"result"` | turn end (`SUCCESS`, else an error upstream) |
| `init.conversation_id` | `SessionStore` entry, replayed via `--conversation` |
| SIGINT | abort (agy has no in-band cancel) |

Launched with `--disable-slash-commands` by default: in stream-json mode a CLI-answered
slash (`/model`, `/usage`) **aborts the whole session**, and chat users type `/…`
constantly. `args: ["--disable-slash-commands=false"]` opts back in; all default flags
are overridable through `args`, since agy's flag parsing is last-wins. Consequently agy
reports no command list and gets no picker entry.

### `agent-common.ts`

Protocol-agnostic pieces both runtimes must behave *identically* on: the child
environment, working-directory resolution (`agents[].cwd`, or an auto-created
`~/.agent-anywhere/agents/<id>`), the reverse-command hint, tool-preview formatting, and
child termination (SIGTERM, then SIGKILL after `KILL_GRACE_MS` — harness CLIs may ignore
SIGTERM mid-turn).

`buildReverseHint()` generates the per-turn `<system-reminder>` from
`REVERSE_COMMANDS`, so the hint can never drift from the actual CLI. See
[`src/ipc/README.md`](../ipc/README.md).

## `daemon.ts` responsibilities

**Slash registration is fixed at startup**, derived from config alone
(`buildRegisteredSpecs`), deliberately *not* the union of what agents report — see
[`core/command-translate.ts`](../core/README.md) for why that union misrouted commands.
Registration is best-effort: a failure is logged, never thrown, since slash is a
convenience over plain text. Duplicate names are deduped defensively (Telegram rejects
the whole `setMyCommands` batch on one duplicate).

**`ask` buttons.** `handleAsk` posts a button message and suspends the IPC response until
a click or timeout (default 120 s), then returns `{ chosen }` to the blocked CLI process.
Button ids are `ask:<reqId>:<index>` — the **index**, not the label, because Telegram
caps `callback_data` at 64 bytes and a longer id degrades to a lossy hash. On resolve or
timeout the buttons are stripped and the message annotated. On shutdown every pending ask
is resolved `null` so no caller hangs forever.

**Harness pickers** (`/claude`, `/opencode`) post the agent's *reported* commands as
buttons — never a guessed list. Names already reachable through the generic vocabulary
are filtered out. Buttons are capped at 25 (Discord's components-per-message limit; the
`claude` harness reports ~39, so this is reached in practice) and the remainder is
**listed as text, not dropped**. A click is delivered straight back to the recorded
session via `dispatchToSession` — re-routing a bare `/init` would send it to
`routing.default`, the exact misdelivery this design removes. The clicker is re-checked
against the allowlist, because a button in a shared channel can be pressed by someone
other than the person who opened the menu.

**Inbound dedup.** On platforms where a slash *is* a normal message (Telegram), one
`/cmd` fires both a message event and a command event with the same `messageId`; they are
deduped by `platform:channelId:messageId` within 15 s. When `messageId` is empty (Slack
slash) dedup is skipped — distinct events would collide on the empty-string key, and
those platforms have no double-fire anyway.

**`lastResolvedSessionId`** is a scratch slot written by `resolveChannel` and read by
`handleReverse`, because IPC's `handle(action, channelId)` signature omits the session id.
It is safe **only** because there is no `await` between the two within one dispatch. The
constraint is documented at the field; if you add an await there, you break it.

**Graceful shutdown** runs once (signals repeat on double Ctrl-C): remove signal
handlers, stop IPC, stop every adapter, clear pending asks/picks, dispose the registry.
Exit codes follow shell convention (SIGINT 130, SIGTERM 143). Without this, resident
child processes are orphaned and the socket file lingers.

## Security-critical files

**`attachment-io.ts`** does the real IO behind `core/attachment-ingest.ts`, and its
guards are the reason for the split. Inbound attachment URLs are user-controlled, so
`assertSafeAttachmentUrl` validates the scheme and rejects internal, loopback, and
cloud-metadata targets — and because a `3xx` `Location` can bounce a public CDN URL to an
internal address that the initial check passed, redirects are followed **manually** with
every hop re-validated (`redirect: 'manual'`, capped at `MAX_ATTACHMENT_REDIRECTS`).
Downloads early-exit on a `content-length` over the cap. Saved filenames are sanitized
against traversal and prefixed with a short hash to avoid overwrite. Coverage thresholds
are set on this file's pure guards specifically (`vitest.config.ts`).

**`session-token-registry.ts`** compares tokens with `timingSafeEqual` against each
registered token rather than a `Map.get`, so a timing side-channel cannot reveal how many
leading characters of a guess are correct. Defense in depth — tokens are 122-bit UUIDs
and the socket is `0600` — but cheap, since the live-session set is small.

**`reverse-cli-shim.ts`** guarantees the hint's promise that `agent-anywhere` is on PATH.
Whether it actually is depends on how the daemon was launched: a global npm install puts
it there, `node dist/cli.js start` or a `tsx` dev run does not, and a service manager may
strip PATH entirely. So the daemon writes a two-line shim re-executing *exactly* the
runtime it is itself running as (`execPath` + `execArgv` + `argv[1]`) and prepends the
shim dir to each child's PATH. This also pins the agent to *this* daemon's version when a
different global one exists. POSIX only; on win32 it returns `null` and the agent falls
back to whatever PATH offers.

## Tests

Twelve test files. `agent-acp.test.ts` and `agent-agy.test.ts` cover protocol
translation; `routing.test.ts`, `command-routing.test.ts`, `session-control.test.ts`,
`session-store.test.ts`, `session-token-registry.test.ts`, `multi-platform.test.ts`,
`slash-register.test.ts`, `ask-button.test.ts`, `permission.test.ts`, and
`attachment-io.test.ts` cover the rest.

`daemon.ts` and `turn-runner.ts` have no direct test file — their pure helpers are
exported and tested from the files above (`parseAskButtonId`, `parsePickButtonId`,
`agentCommandToSpec`, `buildRegisteredSpecs`). When adding logic to either, extract the
decision as a pure exported function and test it there; that is the established pattern.
