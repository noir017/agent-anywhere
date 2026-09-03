# `src/daemon/` — the running system

The only module allowed to depend on every other one. It owns routing, conversation
lifetime, turn orchestration, and the agent runtimes.

Vocabulary, since the two used to be one word and that is much of why this went wrong:
a **conversation** is the IM-side unit (a topic, a thread, a channel — see
[`core/conversation.ts`](../core/README.md)); a **session** is the agent-side one (an ACP
session id, agy's conversation id). One conversation holds one session *per agent*.

## Files

| File | Role |
|---|---|
| `daemon.ts` | Top-level wiring: platforms + conversation registry + IPC. Slash registration, `ask` buttons, harness pickers. |
| `routing.ts` | Pure: inbound → which agent (and whether the user *asked* for it) + which scope |
| `conversation.ts` | `ConversationRegistry` — per-conversation state, agent binding, access + gating, command translation |
| `turn-runner.ts` | One turn end to end: prompt, streaming, tools, footer, errors |
| `agent.ts` | `AgentFactory` / `AgentSession` / `AgentStreamHandlers` interfaces. Dependency-free. |
| `agent-factory.ts` | Dispatch: which runtime serves which agent |
| `agent-acp.ts` | ACP runtime (claude, codex, opencode, gemini, custom) |
| `agent-agy.ts` | Antigravity CLI runtime — its own stream-json protocol |
| `agent-common.ts` | Protocol-agnostic helpers shared by both runtimes |
| `conversation-store.ts` | Persisted per conversation: the bound agent + each agent's own session id |
| `conversation-token-registry.ts` | Per-conversation reverse-command token ↔ conversation id |
| `attachment-io.ts` | Real attachment IO + the SSRF guards |
| `reverse-cli-shim.ts` | Guarantees `agent-anywhere` is on the agent's PATH |

## Inbound flow

```
adapter.onMessage
   │
   ▼
Daemon.onInbound ─── cross-event dedup (platform:address:message, 15 s TTL)
   │
   ▼
ConversationRegistry.route
   ├─ access gate        access.allowFrom — `platform:userId`
   ├─ conversationKey    scope + the message's ConversationRef → the conversation id
   ├─ resolveAgent       routing.pipeline, then HARNESS_COMMANDS → { agentId, explicit }
   ├─ response gate      core/inbound-gate shouldRespond
   ├─ /new · /clear      reset the conversation, drop every agent's id, ack. Never forwarded.
   ├─ /help              the registered vocabulary, from core/command-translate. Never forwarded.
   ├─ unconfigured agent `/agy` with no agy agent → say so, run no turn. Never forwarded.
   ├─ bind or rebind     new conversation → bind; explicit `/oc` → rebind; else keep the bound agent
   ├─ bare command       `/oc` alone → its command menu, or a binding ack if it reports none
   ├─ command translate  generic → native, or refuse
   ├─ header bubble      once per conversation, on receipt
   ▼
InboundMerger.ingest ── merge window / queue / interrupt
   ▼
TurnRunner.runTurn
```

Several orderings in `route()` are load-bearing and commented in place:

- **`hasActiveSession` is read before any merger is built** — otherwise it is always
  true once a conversation exists and the thread-participation exemption is distorted.
- **Gating runs on the original content**, not the prefix-stripped one. A bare `/oc`
  strips to empty and would trip the empty-message gate, losing the usage ack. The gate
  rejects messages that *arrived* empty (a native slash command's phantom message), not
  ones `route` just emptied.
- **Command translation sits after binding**: it is the first point that knows *which*
  agent will answer, and the last point at which the message can still be refused.
- **The header is sent after every gate**, so it cannot become a probe — a message that
  will not be answered gets no acknowledgement of any kind.
- **`/new` is intercepted before the merger**, so it works mid-turn (dispose aborts the
  in-flight turn).
- **The unconfigured-harness check runs before binding**, and only on a name `resolveAgent`
  declined — so a `when.command` rule or a configured harness always wins, and a name nobody
  claimed never binds a conversation on its way to being refused.

## Routing, binding, and conversation keys

`routing.ts` answers two questions with **different lifetimes**, which is why it is two
functions rather than one:

- `resolveScope` — how a conversation is identified. A property of config.
- `resolveAgent` — `{ agentId, explicit }`. Config chooses a conversation's *initial*
  agent; after that the user does.

Both walk `routing.pipeline` in order; the first rule whose `when` **fully** matches
wins, else `routing.default`. Match fields: `platform` (instance id), `serverId`,
`channelId` (matches the channel, ignoring any lane), `userId`, `chat`
(private/group/thread), `isBot`, `command`.

`when.command` matches the leading `/name` of **plain message text**, so command routing
works on every platform regardless of native slash support — `Daemon.onCommand`
synthesizes native invocations into a full inbound message, so one code path covers both.

**Agent commands resolve without a rule.** When no pipeline rule matched on `command`,
`resolveAgent` falls back to `HARNESS_COMMANDS` (`/cc`, `/oc`, `/agy` — see
[`core/command-translate.ts`](../core/README.md)) and selects the first configured agent
of that harness. Those names are what gets registered in the platform menu, so without
this a fresh install advertised commands the daemon did not recognise and forwarded them
to the bound agent as literal text. Precedence:

1. a pipeline rule that matched on `when.command` — hand-wired, so it wins (and can point
   `/cc` at a *second* claude agent, or keep an alias the presets know nothing about);
2. a built-in agent command;
3. whatever rule matched on where the message came from — the initial binding;
4. `routing.default`.

Step 2 sits above step 3 because naming an agent is an instruction, while a rule matching
on platform or channel only supplies that conversation's default answerer.

**`explicit` is the hinge.** It is true when the user *named* the agent — via a
`when.command` rule or a built-in agent command. The registry then:

| situation | what happens |
|---|---|
| conversation is new | bind the resolved agent (or the one the store remembers, after a restart) |
| existing + explicit `/oc` | **rebind**: dispose the outgoing subprocess, keep its stored session id |
| existing + not explicit | **use the bound agent** — the fix for the reported bug |

A non-command rule deliberately does *not* rebind an existing conversation: re-applying
it on every message would make the binding impossible to change, and stickiness
meaningless. The `/name` prefix is consumed, so the target agent never sees it.

Conversation keys carry **no agent id**:

```
shared       → shared
per_user     → <platform>#u#<userId>
per_channel  → <platform>#<channel>
per_thread   → <platform>#<channel>#<thread|>      (default)
```

That absence is the whole point. When the agent led the key, `/oc hi` and the plain
message after it were two different conversations in one topic — the second silently fell
back to `routing.default` with empty context. Under `per_thread` the lane component is
present but empty for a channel root, so a root and a topic can never collide.

## Conversation lifetime

**Conversations live for the daemon's lifetime.** There is deliberately no automatic
reclamation — evicting one would silently drop the agent's context and kill a resident
subprocess, and the live set is naturally bounded by `access.allowFrom` in any sane
deployment. A conversation's context ends only when the daemon stops or the user sends
`/new`.

`ConversationState` is one object per conversation (previously parallel `Map`s). Creation
sets it in one assignment (no half-init), release is one `delete` (no leak), and adding a
field touches only that interface. The stable token is the exception — it lives in
`SessionTokenRegistry`, since token bookkeeping is a separate concern from turn
orchestration.

### The agent owns its context

**The IM side is a client. It must never make an agent restart a task.** That rule
decides the store's shape: `ConversationStore` (`<configDir>/conversations.json`) holds,
per conversation, the bound agent *and* a map of `agentId → that agent's own session id`.

Keying sessions by `(conversation, agent)` is what makes `/oc` → `/cc` → `/oc` *resume*
opencode's thread instead of starting over — and what stops claude from ever being handed
opencode's session id. The harness keeps the actual history on its own disk; this only
remembers *which* of its sessions belongs where, so a restarted daemon can `session/load`
it (ACP) or pass `--conversation` (agy) rather than starting blank.

A missing or corrupt file degrades to empty (bindings lost, agent histories untouched).
`/new` is the single context-destroying path in the system, and it clears **every**
agent's id for that conversation: the topic *is* the conversation, so a reset that let
another agent's history resurface on the next `/oc` would be a surprise rather than a
reset. A pre-0.3 `sessions.json` is migrated on first start (`migrateLegacySessions`), so
in-flight work survives the upgrade.

### Auto-thread adoption

When `autoThread: perTurn` opens a thread mid-turn, the reply moves into it — so the
user's next message arrives from a place that would otherwise key as a *new* conversation,
and the agent would answer its own follow-up from scratch. `TurnRunner` calls
`deps.adoptThread`, and the registry aliases the thread's key to the conversation that
opened it. The alias is in-memory only: after a restart such a thread becomes its own
conversation, which is a self-correcting degradation, unlike discarding context.

## `TurnRunner`

One turn, end to end. It receives a narrow DI interface (`TurnRunnerDeps`) rather than
the whole `ConversationRegistry`, to avoid bidirectional coupling: the registry stays the
sole owner of state and lifecycle, and the runner borrows read-only views (`agentIdOf`,
`tokenFor`, `getModelOverride`) plus two write entries (`setActiveAddress`,
`adoptThread`).

Per turn it: resolves the platform instance from the batch (a shared-scope conversation
may hop instances between turns, so this is per-turn) → resolves the outbound address
(opening a thread first when `autoThread: perTurn`, so the whole turn lands in it) →
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

Everything above this boundary — `ConversationRegistry`, `TurnRunner`, `StreamBuffer`,
`ToolRenderer` — is **protocol-agnostic** and reused unchanged by both runtimes. Keep it
that way: a new protocol means a new sibling runtime implementing `AgentFactory`, not a
branch upstream.

`agent.ts` holds only interfaces and imports nothing from the project — both runtimes
import it, so putting the dispatch there would create a cycle. That is why
`agent-factory.ts` is its own file.

`dispose(conversationId)` fans out to both runtimes rather than tracking ownership:
callers hold only a conversation key, and disposing one a runtime never created is a
documented no-op.

### `agent-acp.ts` — the ACP runtime

The daemon is the ACP **client/host**. Each conversation+agent pair spawns a resident ACP
agent child — one per `(conversationId, agentId)`, which is why two agents can answer the
same topic without sharing a process — and `session/update` notifications are translated
back into `AgentStreamHandlers`:

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
| `init.conversation_id` | stored under `(conversation, agy)`, replayed via `--conversation` |
| SIGINT | abort (agy has no in-band cancel) |

Launched with `--disable-slash-commands` by default: in stream-json mode a CLI-answered
slash (`/model`, `/usage`) **aborts the whole session**, and chat users type `/…`
constantly. `args: ["--disable-slash-commands=false"]` opts back in; all default flags
are overridable through `args`, since agy's flag parsing is last-wins. Consequently agy
reports no command list, so `/agy` switches the conversation but its bare form acks the
binding rather than posting an empty menu.

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

**Harness pickers** — the bare form of an agent command (`/cc`, `/oc`) — post the agent's
*reported* commands as buttons, never a guessed list. Names already reachable through the
generic vocabulary are filtered out. Buttons are capped at 25 (Discord's
components-per-message limit; the `claude` harness reports ~39, so this is reached in
practice) and the remainder is **listed as text, not dropped**. A click is delivered
straight back to the recorded conversation via `dispatchTo` — re-routing a bare `/init`
would resolve it against the pipeline instead of the conversation's bound agent, landing
on whichever agent config prefers rather than the one whose menu offered it. The clicker
is re-checked against the allowlist, because a button in a shared channel can be pressed
by someone other than the person who opened the menu. A harness that reports no list
(`agy`) acks the binding instead — see `HARNESS_COMMANDS` in
[`core/command-translate.ts`](../core/README.md).

Two things about a click are worth stating, because every way this path could fail used
to be a silent `return` — indistinguishable, from the chat, from a dead button:

- **The ack edits the MENU message**, whose ref is captured from the send, not the click
  event's `messageId`. `ButtonInteraction.messageId` is contractually the message the
  button is on, but Telegram's Satori adapter puts the `callback_query` id there — not a
  message id at all — so editing it 400s and the caller swallows it. That was the whole
  visible feedback for a click, and it never applied. The Telegram profile now corrects
  the field at the source too (`rawCallbackMessageId`), which also restores the 👀/✅
  lifecycle reactions on the resulting turn.
- **An expired menu says so.** `pendingPicks` is in-memory and one-shot, so a second click
  or a click after a daemon restart finds nothing — and used to answer nothing.

**Inbound dedup.** On platforms where a slash *is* a normal message (Telegram), one
`/cmd` fires both a message event and a command event with the same `messageId`; they are
deduped by `platform:<address>:messageId` within 15 s. When `messageId` is empty (Slack
slash) dedup is skipped — distinct events would collide on the empty-string key, and
those platforms have no double-fire anyway.

**`lastResolvedConversationId`** is a scratch slot written by `resolveAddress` and read by
`handleReverse`, because IPC's `handle(action, address)` signature omits the conversation
id. It is safe **only** because there is no `await` between the two within one dispatch.
The constraint is documented at the field; if you add an await there, you break it.

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

**`conversation-token-registry.ts`** compares tokens with `timingSafeEqual` against each
registered token rather than a `Map.get`, so a timing side-channel cannot reveal how many
leading characters of a guess are correct. Defense in depth — tokens are 122-bit UUIDs
and the socket is `0600` — but cheap, since the live set is small.

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
`conversation-store.test.ts`, `conversation-token-registry.test.ts`,
`multi-platform.test.ts`, `slash-register.test.ts`, `ask-button.test.ts`,
`permission.test.ts`, and `attachment-io.test.ts` cover the rest.

Two suites are load-bearing for the design rather than for a function:
`command-routing.test.ts`'s *sticky agent binding* block reproduces the reported bug
(`/oc hi` then a plain follow-up must stay with opencode, in one conversation), and
`conversation-store.test.ts` pins the "agent owns its context" invariant — bind, switch
away, switch back, and the first agent's own session id is still there.

`daemon.ts` and `turn-runner.ts` have no direct test file — their pure helpers are
exported and tested from the files above (`parseAskButtonId`, `parsePickButtonId`,
`agentCommandToSpec`, `buildRegisteredSpecs`). When adding logic to either, extract the
decision as a pure exported function and test it there; that is the established pattern.
