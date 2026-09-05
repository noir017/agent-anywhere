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
| `daemon.ts` | Top-level wiring: platforms + conversation registry + IPC. Slash registration, `ask` buttons, harness pickers, the `/model`, `/cd` and `/setting` menus. |
| `routing.ts` | Pure: inbound → which agent (and whether the user *asked* for it) + which scope |
| `conversation.ts` | `ConversationRegistry` — per-conversation state, agent binding, access + gating, command translation |
| `settings-store.ts` | The write half of `/setting`: validate, patch config.yaml, apply to the live `Config` |
| `turn-runner.ts` | One turn end to end: prompt, streaming, tools, footer, errors |
| `agent.ts` | `AgentFactory` / `AgentSession` / `AgentStreamHandlers` interfaces. Dependency-free. |
| `agent-factory.ts` | Dispatch: which runtime serves which agent |
| `agent-acp.ts` | ACP runtime (claude, codex, opencode, gemini, custom) |
| `agent-agy.ts` | Antigravity CLI runtime — its own stream-json protocol |
| `agent-common.ts` | Protocol-agnostic helpers shared by both runtimes |
| `conversation-store.ts` | Persisted per conversation: the bound agent, each agent's own session id, and the directory it works in |
| `workdir-scan.ts` | The `/cd` option list: an agent's configured root plus the projects one level inside it |
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
   ├─ /stop              cancel the running turn and the queued backlog, ack. Never forwarded.
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
  in-flight turn). `/stop` sits beside it for the same reason: a stop command that only
  worked between turns would be useless exactly when it is wanted.
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

**A conversation lives for the daemon's lifetime; its agent process does not.** The
conversation ends only when the daemon stops or the user sends `/new`. The resident
harness child under it is reclaimed after `session.idleTimeoutMs` of silence — see
[Idle reclaim](#idle-reclaim) below.

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
`/stop` is the narrow sibling of `/new` and touches none of this: it cancels the running
turn and drops the queued backlog through `InboundMerger.interrupt()`, leaving the
context, the session ids, the binding and the child process exactly as they were. It
deliberately does not reach the agent through `agents.getOrCreate` — building a session
for a conversation that has none, in order to stop it, is backwards; the abort travels via
the merger, which only fires it in the `running` phase where a session must exist.

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

### Idle reclaim

`scope: per_thread` means every topic anyone has ever messaged holds its own resident
harness child, and a Claude Code process is hundreds of MB. So after
`session.idleTimeoutMs` (user-facing, default 1 h, `0` disables) the registry's sweeper
stops the child of a conversation nothing is happening in.

**Reclaim is the restart path, applied one conversation at a time.** A daemon restart
already kills every child and resumes each conversation from the session id in
`conversations.json` — ACP `session/load`, agy `--conversation`. This does that to one
idle conversation deliberately, to get its memory back. Nothing that identifies the
conversation is touched: state, binding, reverse-command token and stored session ids all
stay, and `AgentSession.dispose()` is called rather than `AgentFactory.dispose()` so the
session HANDLE survives too — which is what keeps the conversation's runtime `/model`
choice across the respawn. The only thing a user can perceive is that the next message
waits a few seconds for the child to come back.

That earlier paragraph in this file claiming reclaim would "silently drop the agent's
context" predates `conversations.json`. It was true when the daemon held the only copy of
which session belonged where.

Four conditions, each protecting against a different way of being wrong:

| gate | what it prevents |
|---|---|
| quiet longer than the deadline | — |
| `merger.isIdle()` | killing work in flight. The clock starts when the last turn ENDED (the merger's `onIdle`), so a task that runs for hours — subagents included — is never a candidate while it runs |
| `hooks.hasPendingWork(id)` | stranding a pending `ask`: a CLI process blocked on a button click is work this conversation is doing from outside any turn |
| `AgentSession.reclaimState() === 'resumable'` | silently restarting the user's task on a harness that cannot reload a stored session |

A reverse command also counts as activity (`handleReverse` → `registry.touch`), so an
agent whose turn ended but whose background job is still reporting through
`agent-anywhere send` keeps its child. A session that reports `unresumable` is left
resident and said so once, not once a minute.

Verified resumable on the three harnesses in use: `claude` (claude-agent-acp advertises
`loadSession: true`), `opencode` 1.18.18 (same, plus `sessionCapabilities.resume`), and
`agy` (`--conversation=<id>`, recorded as soon as its `init` event names one).

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
  no footer, no ✅, skip the command fallback. The continuing batch produces its
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
| `init.model` | `onModel` — stored at spawn, replayed at the top of every turn |
| SIGINT | abort (agy has no in-band cancel) |

Launched with `--disable-slash-commands` by default: in stream-json mode a CLI-answered
slash (`/model`, `/usage`) **aborts the whole session**, and chat users type `/…`
constantly. `args: ["--disable-slash-commands=false"]` opts back in; all default flags
are overridable through `args`, since agy's flag parsing is last-wins. Consequently agy
reports no command list, so `/agy` switches the conversation but its bare form acks the
binding rather than posting an empty menu.

Models: agy names the one it is serving in `init` and nowhere else, so the footer can print
it (`onModel` is replayed each turn, because the footer reads a per-turn record). There is
no selector and no in-process switch — the model is fixed by `--model=` at spawn — so
`modelSelector`/`setModel` stay unimplemented and `/model` is answered "not supported"
rather than with a menu that could never apply.

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
is resolved `null` so no caller hangs forever. A pending ask also holds its conversation
against idle reclaim (`hasPendingWork`): from the registry's side that conversation looks
idle, while a CLI process sits blocked on a button nobody has pressed yet.

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

**The model menu** — a bare `/model` where the platform can post buttons *and* replace them
(`capabilities.editButtons`). The registry decides who the menu is for and hands over the
live selector; `daemon.ts` posts it, pages it and acks it. Three things it does differently
from the harness picker, each for a reason:

- **It is not one-shot.** Paging is the point, so a page click leaves the entry in place;
  only a successful pick (or a `gone`/`rebound`/`missing` outcome) retires it.
- **At most one live menu per conversation.** Opening a new one retires the old *in place*,
  saying so on the message rather than leaving live-looking buttons behind. That is what
  bounds `pendingModelMenus` — by live conversations, which `access.allowFrom` already
  bounds — with no TTL (which would expire a menu still on screen because a clock ran out)
  and no LRU (which would let one user's traffic kill another's open menu).
- **The option list is frozen at open, and the resolved VALUE is re-checked at click.** A
  pick id carries an absolute index into that snapshot; the page a button targets lives in
  its id too, so the daemon holds no page cursor that could disagree with the screen. The
  harness can rebuild its list mid-session, and without the value re-check a stale index
  would switch to a model the user never saw — the one path here that could be silently
  wrong. `ConversationRegistry.applyModelChoice` does that check, along with "conversation
  still exists", "same agent still bound", and "there is a live selector at all".

The pure half — paging, labels, ids, matching, and every string either surface says — is
[`core/model-menu.ts`](../core/README.md), so the menu and `/model <query>` cannot answer
differently.

**The settings menu** — `/setting`, on the same capability test as the model menu, and built
on the same three rules (not one-shot, at most one per conversation, frozen snapshot +
re-read value). Two levels in one message: the row list, and one setting's values. It differs
from the model menu in what a pick does and what it costs:

- **A successful write returns to the LIST**, with the ack above it and the changed row
  showing its new value. Changing two settings in a row is the normal case, so the screen
  keeps working instead of retiring. Anything that did *not* write stays on the value level.
- **The clicker is re-checked against `access.allowFrom`** — as on every menu, but here the
  click does not merely change who answers a conversation: it edits the operator's
  config.yaml. (Where the allowlist is empty nothing new is granted either — agents already
  run with full tool access, so anyone who can message the bot can edit that file directly.
  See [security invariant #1](../../AGENTS.md#security-invariants).)
- **Row identity comes from the frozen list; the value is re-read every redraw.** So a menu
  left open across a change from the other surface shows the current value, while a button
  still means the setting it was drawn for.

`ConversationRegistry` owns the writing (`applySetting`, `settingRows`, `settingOptionsFor`)
for the same reason it owns `applyModelChoice`: it holds the `Config` that has to be mutated
and the sessions whose model list validates a value. `daemon.ts` owns the buttons. The pure
half is [`core/settings.ts`](../core/README.md); the file itself is written by
`settings-store.ts` (below).

## `settings-store.ts`

Six steps, in a fixed order: parse the value (core), skip a no-op write, **validate a whole
candidate config**, resolve the on-disk path, patch the file, apply in memory.

Step three earns its keep on its own. `/setting` writes the file the daemon needs in order to
*start*, from a chat message — so a value that parses but fails `ConfigSchema.superRefine`
would leave a deployment that runs until someone restarts it and then refuses to. Validating
a candidate copy first turns that into a refusal in chat. Nothing throws: every failure
becomes a `SettingApplyResult`, because one of the two callers is a button click with nobody
to re-prompt.

Two details that are easy to get wrong:

- **The `agents[]` index is resolved against the FILE**, not the runtime array
  (`readRawConfigIfExists`). If anyone reordered `agents:` by hand since startup, patching by
  the in-memory index would set the wrong agent's model — silently, which is the worst
  outcome available here.
- **Clearing a value deletes the key**, it does not write `null`. `agents[].model` is
  `z.string().optional()`, so a `null` would fail the very next `loadConfig` — a write that
  bricks the file it was clearing. `saveConfigPatch` treats `value: undefined` as a delete
  for exactly this.

Only the single scalar the user chose is patched, through the yaml Document API, so comments,
key order, hand-edited siblings and `${VAR}` templates all survive byte-identical — the
validated candidate, which holds *expanded* values, never reaches disk. See
[security invariant #4](../../AGENTS.md#security-invariants).

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

One URL class never reaches those guards: a platform that declares `fetchAttachment` gets first
refusal on each URL, and Lark's `internal:lark/…` resource addresses are fetched through the
bot's own authenticated client instead (nothing else *can* fetch them — the guard rejects the
scheme, which is why a Feishu image used to arrive as "failed to download"). That is not a hole
in the SSRF model: those requests go to the vendor endpoint the operator configured, with the
bot's token, and the only user-controlled part is a path segment the profile validates against
Feishu's id alphabet. The size cap still applies and is enforced after the fetch, since that
route reports no `content-length` to pre-check.

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

Sixteen test files. `agent-acp.test.ts` and `agent-agy.test.ts` cover protocol
translation; `routing.test.ts`, `command-routing.test.ts`, `session-control.test.ts`,
`session-reclaim.test.ts`,
`conversation-store.test.ts`, `conversation-token-registry.test.ts`,
`multi-platform.test.ts`, `slash-register.test.ts`, `ask-button.test.ts`,
`picker-click.test.ts`, `model-menu-click.test.ts`, `settings-command.test.ts`,
`local-commands.test.ts`,
`permission.test.ts`, and `attachment-io.test.ts` cover the rest.

`settings-command.test.ts` is the only suite here that asserts against a real file on disk
(`AGENT_ANYWHERE_CONFIG_FILE` pointed at a tmp dir), and deliberately so: its most valuable
assertions are that a refusal leaves the file byte-identical, that clearing deletes a key
rather than writing a `null`, that a `${VAR}` template is never expanded on the way through,
and that `loadConfig()` still succeeds afterwards. Each of those, if it broke, would produce
a deployment that runs fine until someone restarts it.

`session-reclaim.test.ts` is written almost entirely as negative assertions, for the same
reason the click suites are: every gate that fails open produces an agent that silently
forgot a task, and none of them announce themselves.

Two suites are load-bearing for the design rather than for a function:
`command-routing.test.ts`'s *sticky agent binding* block reproduces the reported bug
(`/oc hi` then a plain follow-up must stay with opencode, in one conversation), and
`conversation-store.test.ts` pins the "agent owns its context" invariant — bind, switch
away, switch back, and the first agent's own session id is still there. A third,
`model-menu-click.test.ts`, exists for the same reason `picker-click.test.ts` does: on a
button, a silent `return` is indistinguishable from a dead button, so every way a click can
fail has a test asserting it produces words.

`daemon.ts` and `turn-runner.ts` have no direct test file — their pure helpers are
exported and tested from the files above (`parseAskButtonId`, `parsePickButtonId`,
`agentCommandToSpec`, `buildRegisteredSpecs`). When adding logic to either, extract the
decision as a pure exported function and test it there; that is the established pattern.
