# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [1.7.1] - 2026-09-11

### Fixed

- **A daemon restart no longer re-narrates the whole conversation into the chat.** Resuming a
  stored session replays its entire history as ordinary `session/update` notifications, and the
  gate that suppresses them (`promptedYet`) was a race: the flag is written by the sender just
  before `prompt()`, but read by the reader at dequeue time, and between the two there are only a
  handful of microtask ticks. The reader dropped whatever it reached in that window and rendered
  everything after it as if it were the new turn's own output.

  The window is proportional to the history, so this was never a rare race — it was one a
  conversation is guaranteed to lose once it gets long enough. Observed on 2026-09-11 after
  restarting into 1.7.0: exactly five replayed updates were suppressed and the remainder, hours of
  conversation, was re-sent to Telegram as one reply.

  The gate is now a fence the reader itself releases. By the time `session/load` returns, every
  replayed notification is already queued — the agent emits them before answering and one JSON-RPC
  stream is ordered — so the replay is a finite buffered prefix and "the reader has caught up" is
  decidable: race each read against a macrotask, which can only win when nothing is buffered.
  `runTurn` waits on that before setting the flag. The regression test replays three hundred
  messages, where the old gate leaks two hundred and ninety-six.

  Not caused by 1.7.0 — the race predates it, and the release only supplied a conversation long
  enough to expose it. The existing test replayed two messages, which always won.

### Changed

- **`ask` is advertised again on harnesses that cannot ask for themselves.** 1.7.0 dropped it from
  the injected hint on the grounds that the model's own question tool had replaced it, which is
  true only where that tool exists. `opencode` and `dsh` send no elicitations, so the change
  silently cost them their buttons: a model that wanted a decision could only ask in prose. The
  `inject` flag now distinguishes `'always'` from `'no-native-ask'`, so claude still gets a
  one-line hint and the others get `ask` back.

## [1.7.0] - 2026-09-11

### Added

- **The agent can ask you a question, and wait.** The daemon now advertises ACP's
  `elicitation.form` capability at `initialize` and renders the resulting
  `elicitation/create` requests as buttons in the chat.

  This was not a missing feature so much as one the gateway had been switching off. The
  claude adapter gates the model's own `AskUserQuestion` tool on that capability
  (`disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"]`), so every session
  this daemon ever opened ran with the model's question tool disabled — and the workaround, an
  `ask` reverse command plus the longest entry in the injected hint, existed to replace what one
  line of the handshake had removed. Now the model uses the tool it already knows and nothing is
  injected to teach it.

  Each option's rationale is rendered into the message body above the buttons, because that text
  ("you already run pgvector here, so reusing it costs nothing") is often the most useful part of
  the question and no platform's button label can hold a sentence. Multi-question forms are asked
  one round at a time, and abandoned on the first unanswered round rather than collecting answers
  the agent cannot use. A turn with a question outstanding is no longer treated as hung: the
  silence watchdog re-arms while waiting on a person, which it previously did not, and would have
  aborted the turn mid-decision.

  The capability value must be an object (`{ form: {} }`), not `true` — verified against the ACP
  schema and both harnesses. `form: true` is accepted by claude and by dsh, but opencode
  validates it strictly and rejects the whole `initialize` with `-32602`, which would have taken
  down every opencode session rather than just its elicitations.

  Probed live: `claude` sends real elicitations; **`opencode` 1.18.27 and `dsh` 0.1.2-rc.1 send
  none** (opencode sends no reverse requests at all, not even `session/request_permission`). On
  those two the model asks in prose and ends its turn, which the user answers in the next
  message — no code needed for the fallback.

### Changed

- **The per-turn hint is one line instead of thirteen.** It used to list all nine reverse
  commands with their full usage: roughly 350 tokens of chat-bot operating manual, in the *first
  text block* of every session's opening turn, ahead of whatever the user had actually asked. The
  cost was the framing more than the tokens — a model that opens by reading how to react with
  emoji and page through message history has been told what kind of job this is before it sees
  the job.

  Most of the list was also redundant. Plain text already streams into the chat, so `send-message`
  and `reply` are slower ways to do what happens by itself; `edit-message` duplicates the message
  the daemon already live-edits; `ask` is now the harness's own tool; and `react` / `delete` /
  `create-thread` / `fetch-messages` describe a chat client's chrome rather than the work. What
  remains is `send-file`, the one act the text channel cannot perform.

  The other eight commands are **not removed**. They are still registered, still in
  `agent-anywhere --help`, and still work when typed or scripted — a new `inject` flag on
  `ReverseCommandSpec` governs only what reaches the prompt, so `REVERSE_COMMANDS` stays the
  single source of truth.

- **A DM no longer prefixes every message with your name.** The `[<authorName>] ` prefix exists
  so an agent in a busy group can tell two speakers apart; in a one-to-one conversation it named
  the only human present, on every turn, and opened each turn with chat-transcript formatting
  instead of the question. It is now added in groups and threads only.

  Keyed on the conversation kind rather than on "does this batch contain two speakers": a batch is
  one merge window wide, so in a busy group two people usually land in different batches, and the
  per-batch test would have dropped the names in exactly the conversation that needs them.

## [1.6.0] - 2026-09-09

### Changed

- **A topic takes its name while the turn is still running.** 1.5.0 asked for the name after a
  turn ended successfully, which made it arrive one whole turn late — and a turn is not a moment:
  the ones worth opening a topic for run for minutes, and you spend all of them looking at a topic
  column that still says whatever the topic was created as.

  Nothing in the naming path needed the turn's outcome. The seed is the opening message and the
  lane is recorded before the agent is asked anything, so the call now starts there and the rename
  lands as soon as the model answers — a second or two in, beside the work rather than after it.
  Everything else is unchanged: once per conversation, same endpoint, same fallback, still never
  awaited by the turn.

  One behaviour goes with it. The old trigger required a *successful* turn, so that a topic could
  not be labelled with something that failed; a conversation whose first turn errors is now named
  anyway. That guard was on the wrong text — the name comes from the request, which is no less what
  the topic is about for the harness having failed to answer it, and a topic whose first turn broke
  is exactly the one you need to find again in the column. Slash-command turns are still skipped.

## [1.5.0] - 2026-09-09

### Changed

- **A topic is now named once, by a model, from its opening message.** 1.3.1 named a topic by
  following the harness's ACP `session_info_update` title, and 1.4.0 shipped a fallback for the
  three harnesses out of four that emit none — the first 39 characters of the opening message. Both
  produced names the user could not navigate by. The harness title is regenerated as a session
  moves on, so a topic drifted to whatever had been discussed most recently rather than what the
  topic is for; and the fallback is a substring, not a summary, so `帮我看下这个报错` and the first
  line of a pasted stack trace both became topic names.

  Naming now happens exactly once per conversation — after its first successful turn, from the whole
  opening message — and never again until `/title` or `/new`. The harness's title is no longer read
  at all: `AgentStreamHandlers.onTitle` and the `session_info_update` case in the ACP translator are
  gone, and the notification falls through to `default: break`.

  The summary comes from any OpenAI-compatible endpoint, configured under a new top-level `title`
  block:

  ```yaml
  title:
    llm:
      baseUrl: http://newapi:3000/v1
      apiKey: ${OPENAI_API_KEY}
      model: gemini-3-flash-lite
      timeoutMs: 45000            # optional
  ```

  One call per conversation, ~60 tokens, 1-4s on a flash-tier model, and nothing waits on it — the
  reply has already been delivered. Leave `title.llm` out and the name is the 1.4.0 substring, which
  is also what a failed call falls back to, so naming never depends on the endpoint being up.

- **`/title auto` now re-arms naming instead of releasing a pin.** With naming gated on "does this
  conversation have a name on record", releasing the pin would have changed nothing. It now forgets
  the recorded name, so the next reply names the topic afresh; the lane keeps its current name in
  the meantime, because a topic briefly called nothing is worse than one briefly called the wrong
  thing.

## [1.4.0] - 2026-09-09

### Fixed

- **Tool progress no longer disappears during a long run of tool calls.** IM platforms cap a
  message two ways — how long it may be, and how often it may be rewritten. The length half was
  fixed for the tool bubble in 1.1.1; the rewrite half never was. Under `accumulate` grouping the
  renderer edited one bubble on every tool start *and* every tool finish, with no throttle and no
  backoff, and `paint()` rethrew anything that was not a `MessageNotEditableError`. A run of
  back-to-back tool calls is therefore two writes per tool into one chat: Telegram answered
  `429 Too Many Requests`, the rethrow was swallowed by the render chain as one
  `[turn] render side effect failed:` line, and the update was gone for good — nothing re-triggers
  a paint until the next tool event, so the bubble froze on stale progress. One daemon run logged
  78 of them, with `retry after` climbing to 229 seconds.

  Painting is now asynchronous and retried. `onToolStart`/`onToolFinish` update the line set and
  return, off the turn's side-effect chain, so a rate-limited chat can no longer stall the reply
  behind a progress bubble. Any failure that is not a seal keeps every piece of state and arms a
  retry, and delivery is tracked by a revision watermark rather than a boolean — a ✓ recorded while
  a write is in flight was not delivered by that write, and the old flag claimed it was.

- **All outbound writes to one chat now share one budget.** The 429s were never any single
  writer's fault. `StreamBuffer` throttled itself to ~1 edit/1200 ms, `ToolRenderer` did not
  throttle at all, and the reactions, acks, menus and the agent's own `agent-anywhere send-message`
  calls were unmetered by construction — but the platform counts all of them as a single stream per
  chat, so no writer could see the quantity actually being limited. A new `core/outbound-pacer.ts`
  (token bucket per chat, one FIFO, in-place coalescing of queued edits) is applied once to every
  adapter in `Daemon`'s constructor, so all ~38 outbound call sites are metered without touching
  any of them. Keyed on `platform:channel` and never the thread, because a Telegram forum topic
  shares its parent chat's flood budget.

  Under congestion the lanes differ: the reply is never dropped however long it waits, a tool
  bubble may be superseded by a newer paint or dropped once stale, and a typing beat is dropped
  immediately. A finishing turn stops *waiting* for its bubbles after `outbound.finalizeWaitMs`
  without cancelling them, so a chat paused for 229 s can no longer hold the turn — and the user's
  ✅ — open for the same 229 s. `stop()` drains the queue before the adapters go down.

- **A stated `retry_after` is obeyed instead of guessed at.** `stream.maxBackoffMs` defaults to
  10 s, which is a blind guess about how long a rate limit lasts and was 22× short of the 229 s
  Telegram actually asked for. Profiles now translate their own failures through a
  `PlatformProfile.classifyError` seam applied to *every* outbound call, so Telegram's 429 becomes
  a typed `RateLimitedError` carrying the number and both writers wait exactly that long. The
  number is recovered by regex over the error message because `@satorijs/adapter-telegram` rethrows
  a fresh `Error` and discards `parameters.retry_after`; `telegram.contract.test.ts` fails loudly
  if that format ever changes. Lark's `230072` mapping moves behind the same seam and now covers
  sends and card patches, not just `editMessage`.

- **A backoff holds back the character threshold too.** `StreamBuffer` gated only its idle timer on
  the backoff, so a rate-limited stream that kept producing text still retried every
  `stream.charThreshold` characters — deepening the limit rather than letting it expire.

- **Running the test suite no longer breaks the reverse CLI of the daemon on the same machine.**
  `ensureReverseCliShim()` derives the shim from `process.argv[1]` — a good clue to "how was I
  launched", but only when the process really is the CLI. In a vitest worker `argv[1]` is
  tinypool's worker entry, and the shim is written to `~/.config/agent-anywhere/bin`, a path shared
  with whatever daemon is running on that machine. So `npm test` repointed the live daemon's shim
  at a test-runner entry, and because that directory leads every agent's `PATH`, every
  `send-message` / `ask` / `send-file` from every live conversation began failing instantly with a
  stack from inside tinypool. The shim is now written only when `argv[1]` is recognisably this CLI
  (a global-install symlink, `dist/cli.js`, or `src/cli.ts`); anything else leaves the file
  untouched and falls back to whatever `PATH` already offers.

## [1.3.1] - 2026-09-08

### Fixed

- **Topic names now start with the agent, and no longer leak the speaker's name.** Two problems
  reported against 1.3.0's rename. Names are shaped `[<agent>] <subject>` — `[cc]`, `[oc]`, `[dsh]`,
  `[agy]` — because a column of topics named only after their subject says nothing about who is
  answering in each, which is the first thing you need when several run at once. And a leading
  bracketed group is stripped before the tag goes on: `mergePrompt` prefixes every message with
  `[<authorName>] ` so an agent can tell speakers apart in a group batch, and the harness summarised
  that into the title, producing topics called `[no id] 合并到main并重试` after the user's own
  Telegram display name. Stripping repeatedly also makes the shaping idempotent, so re-titling
  replaces the tag rather than stacking another.

- **`/oc`, `/dsh` and `/agy` topics are named at all.** Only `claude` emits ACP
  `session_info_update`; opencode carries the variant in its schema and never sends one, dsh lacks
  it, and the agy protocol has no notion of a title — so three agents out of four kept their
  creation-time topic name no matter how long they ran. A conversation nothing has named now takes
  one from the user's own opening message after its first successful turn. Strictly subordinate: a
  real harness title always overrides it, and it never fires for a slash command or a failed turn.

## [1.3.0] - 2026-09-08

### Added

- **A conversation's topic takes the name the agent gave it.** A Telegram forum topic keeps whatever
  name it was created with for as long as it exists, so a topic-per-task workflow ends up as a
  column of names typed before any of the work happened. Meanwhile the harness has been generating
  an accurate title the whole time and reporting it over ACP as `session_info_update` — which the
  gateway dropped on the floor (`translateUpdate`'s `default: break`). The title now renames the
  topic, through a new `renameThread` capability on the platform layer implemented for Telegram via
  `editForumTopic`. Off with `platforms.<id>.autoRenameThread: false`.

  Two things were needed to make the signal arrive at all. First, claude-agent-acp sends the
  notification from its turn-end idle handler, which runs *after* the code that settles the prompt —
  so it lands in the SDK's update queue behind the `stop` that ended the read loop, and the next
  turn's `drainResidualUpdates` discarded it unread. The daemon log showed exactly this as
  "dropped 1 residual update(s)" after every single turn; the drain now salvages a title out of the
  residue before clearing it. Second, the title is generated in a background task, so it describes
  the turn *before* the one that reports it — one turn late by construction.

  Only the ACP harnesses report a title (`claude` observed; `opencode`'s schema carries the variant;
  `dsh` does not, and the agy protocol has no notion of one), so a conversation with no title is the
  normal case rather than a failure.

- **`/title`** — name the current topic by hand, `/title auto` to hand naming back to the agent, or
  bare to see what it was last called. A name set this way is *pinned*: the automatic rename stops
  following the harness for that conversation, because an explicit command that the next turn
  silently reverts is indistinguishable from a broken one. Note what cannot be guarded: Telegram
  offers no way to read a topic's current name back, so a rename done in the Telegram UI is
  invisible to the gateway and will be overwritten by the next new title.

### Fixed

- **`dsh` was registered as a harness but not reachable as a command.** `/dsh` was missing from the
  agent-command table, and `/model` / `/context` reported "not supported" for it despite its ACP
  bridge exposing both. (Committed before this release was cut; recorded here so the release notes
  are complete.)

- **`/model` works before a conversation's first turn.** Under ACP the model list arrives in the
  `session/new` response, so `modelSelector()` had nothing to report until a turn had run — and
  `/model` answered "No model selector on this session yet — send a message, then /model". That was
  wrong in the flow it broke most: the directory menu invites picking a project and then a model, and
  `/cd` makes it worse than a fresh conversation by disposing the session, so even an established
  conversation lost its list. `AgentSession` gained `ensureSession()`, and the gateway now starts the
  session to answer the question — the same child the next message would have started anyway, with no
  prompt sent and no context spent. Fixed in the shared layer, so it covers `cc`, `oc` and `dsh`
  alike (`agy` was unaffected: it reads its list from `agy models`, though a `/model` in the first
  moments after a daemon start could previously race the prefetch, which is fixed too).

  A failure to start now reports its real reason ("must be logged in…") instead of sending the user
  to do the one thing guaranteed to fail the same way.

  `/setting`'s model row is deliberately NOT warmed: doing it there would spawn a child to answer
  `/setting banana`, and warming at the click instead would mean making the daemon's synchronous
  menu path async.

- **A second child could be spawned for one ACP session.** `ensureStarted` assigns `active` only at
  the *end* of startup, so with two callers — a turn beginning and a `/model` warm-up — the second
  would see no session, spawn its own child and overwrite `proc`, leaving the first as an orphan that
  no `dispose` could reach while still holding the harness's session. Concurrent callers now share
  one in-flight startup.

- **`ask` no longer looks broken when someone takes more than two minutes to answer.** The default
  timeout was 120s, which is well inside the time it takes to read a notification, switch apps and
  think — and the failure was silent, since `ask` prints an empty line on timeout exactly as it does
  when nothing was chosen. An agent could not tell "nobody clicked" from "this command does not
  work", and would stop using `ask` at all. The default is now 10 minutes, a timeout writes an
  explicit note to stderr, and the hint injected into agent prompts documents both `--timeout` and
  what a blank answer means. The timeout constant also moved to `ipc/protocol.ts`: the daemon and the
  CLI each held their own copy of `120_000` (the CLI sizes its socket deadline from it), and tuning
  one without the other makes the CLI abandon a question the daemon is still waiting on.


## [1.2.1] - 2026-09-06

### Added

- **`dsh` (DeepSeek Harness) harness preset.** The gateway can now drive DeepSeek Harness over ACP
  (`harness: dsh`), the same way it drives opencode — `dsh --profile acp` is the dsh equivalent of
  `opencode acp`. dsh's ACP bridge encodes its model selector as a JSON string (`["provider","model"]`)
  rather than the "provider/model" spelling agent-anywhere uses everywhere else, so the daemon
  translates between the two at every model boundary: a configured `agents[].model` is JSON-encoded
  before `set_config_option` (a bare string is rejected as "unknown model option"), and the `/model`
  menu decodes dsh's values back to "provider/model" for display and for typing a switch. Note dsh
  ignores the ACP `_meta.model` hint entirely, so the model is enforced through the protocol's own
  setter, exactly as for opencode.

- **`/model` support for the `agy` (Google Antigravity CLI) harness.** The AGY harness previously
  answered `/model` with "not supported" because its stream-json protocol has no in-process model
  switch. It now supports runtime model inspection and switching using a kill-and-respawn strategy:
  the available model choices are discovered via `agy models` and cached at factory startup, and
  `/model` (both the paginated button menu and `/model <name>` substring matching) switches the model
  by terminating the resident child and respawning on the next turn with `--model=<new>` and
  `--conversation=<id>`. Conversation context is retained across the switch through agy's native
  conversation recovery.

## [1.2.0] - 2026-09-05

### Added

- **`/cd`: choose the directory a conversation works in.** `agents[].cwd` was the only answer to
  "where does this agent work", so a machine with a dozen projects on it was reachable one project
  at a time, by editing config.yaml and restarting every resident agent. The directory is now a
  property of the CONVERSATION, recorded in `conversations.json` next to the binding and read by
  both runtimes at spawn — so one topic can be about one project and the next about another.

  The candidate list is derived, not declared: the agent's own `cwd` plus the directories one level
  inside it (`daemon/workdir-scan.ts`), so a new project appears in the menu by existing on disk and
  nothing in config can drift out of date with what is there. `/cd` alone opens a paginated button
  menu on the page holding the current directory; `/cd <part of a name>` switches by substring on
  every platform. Both surfaces are built from `core/workdir-menu.ts`, the same split `/model`
  already used.

  The question is asked at the two moments it costs nothing: a bare agent command (`/cc`, `/oc`,
  `/agy`) in a conversation that has never run, and right after `/new`. A conversation already under
  way still gets the harness command list it always got — and "already under way" is read from the
  stored session id rather than from a live child, so an idle-reclaimed conversation resumes where it
  left off instead of being asked to re-pick.

  Moving starts a fresh session in the new directory, which the menu says before the tap: a session
  is pinned to the directory it was created in (ACP takes `cwd` at `session/new`, agy at spawn), so
  the move cannot reach a running process. Every agent's session id is dropped, not just the bound
  one's — the directory belongs to the conversation, so a later `/oc` must not resume opencode's
  thread from the old project. Re-picking the directory already in use (marked ●) costs nothing.

### Changed

- **`/new` keeps the conversation's binding and its working directory.** It always meant "clear the
  context", but for a conversation driven entirely by commands — one whose in-memory state had not
  been built yet — it also dropped the persisted binding. Both are re-recorded now; only the history
  is gone.

- **The footer's `cwd` field reports the directory actually serving the turn**, rather than
  `agents[].cwd`, which after a `/cd` is no longer the same thing.

## [1.1.2] - 2026-09-05

### Added

- **`contextWindow` per-agent override for the footer's context size.** claude-agent-acp carries a
  hardcoded model table and falls back to a 200k window for any id missing from it — so with
  `ANTHROPIC_MODEL=claude-opus-5` (absent from the table) the footer read `/ 200k`, while a session
  that happened to be on `claude-opus-4-8` (present) read `/ 1M`. The same agent showed two different
  windows depending only on which model the session landed on, even though the gateway serves 1M for
  both. The real limit is a local fact, so it is now stated in local config rather than probed: set
  `contextWindow: 1000000` on the agent and `usage_update`'s `size` is overridden before it reaches
  the footer. Unset = trust the harness's number (unchanged behavior).

### Fixed

- **`/model` no longer reports "No model selector" after an idle reclaim.** The choice list is read
  from the session's last-reported config options, but idle reclaim cleared them along with the child
  it stopped — so a conversation that had been talking for an hour, then went quiet past
  `session.idleTimeoutMs`, answered `/model` as if it had never started. `resetHandles` now keeps
  `liveConfigOptions` across a reclaim (only the live model name, which each new child re-reports, is
  cleared), and `setModel` on a stopped child records the choice as the conversation's preference
  instead of throwing `no live session yet` — the same `modelPreference` that already survives a
  crash and is re-applied when the next turn spawns a child. The next spawn refreshes the list either
  way.

## [1.1.1] - 2026-09-05

### Fixed

- **Tool bubbles no longer vanish on a long turn.** A bubble that accumulated past the platform's
  per-message limit is now sealed and continued in a new one, the same way the message body already
  was.

  `core/README.md` has always documented three reasons a message is sealed — budget spent, full,
  not editable — and said the tool bubble follows the same rule. It followed two of them. There was
  no length limit in `ToolRendererOptions` at all, so under `accumulate` grouping the bubble simply
  grew: every tool start and finish repainted it, and a turn with enough tools eventually wrote past
  what one message can hold. Telegram answers `MESSAGE_TOO_LONG` to the edit and `text is too long`
  to the send. Neither is a `MessageNotEditableError`, so `paint()`'s recovery did not catch them and
  rethrew instead — the render side-effect chain swallowed the rejection, and the whole block of tool
  progress disappeared, leaving one `[turn] render side effect failed:` line in the log. One
  operator's daemon log had accumulated 2083 of them.

  `maxMessageLength` and `measureLength` are now wired into the renderer alongside `maxEdits`, from
  the same platform capabilities the body stream already uses — so the length is measured on the
  RENDERED text, which matters wherever markdown rendering expands it (Telegram turns tables into
  bullets, roughly 1.4x). Two cases a seal alone cannot fix are handled explicitly: when the lines
  carried over still overflow, the oldest go first, because those are the ones already readable in
  the sealed bubble above; and a single line longer than the entire limit — a `verbose`-mode JSON
  dump — is clamped, on the grounds that delivering part of it beats having the platform reject all
  of it.

## [1.1.0] - 2026-09-05

### Changed

- **Replies are no longer streamed by default.** A reply now arrives as a whole message once each
  part of it is finished, split across several messages when it exceeds the platform's per-message
  limit. Live streaming is still available as `stream.enabled: true`.

  Streaming was costing more than it returned. Every flush spends a message edit, platforms cap
  those per message — Feishu allows 20, then refuses *that message* permanently — and so the reply
  most likely to run out of edits partway through delivery was the long, considered one that
  mattered most. 1.0.0 made that survivable by sealing the exhausted message and continuing in a new
  one, but the honest fix is not to spend the edits at all: sent-once text has no such ceiling, and
  the only limit left is message length, which splits cleanly.

  The turn does not go quiet in exchange. `TurnRunner` already completes the body buffer at every
  tool boundary, so each finished text segment is sent as it happens — a turn that uses tools still
  reports as it goes, alongside the session header bubble, the 👀 reaction, and the tool bubbles,
  which do still refresh in place.

  The switch is `stream.enabled` (default `false`), also reachable as `/setting stream on|off` and
  in effect on the next reply. It is ignored on platforms that cannot edit messages (QQ, LINE,
  WeCom, DingTalk), which have always delivered whole segments. The knobs that *pace* a stream
  (`charThreshold`, `flushIntervalMs`, the backoff cap) stay frozen in `EXPERIENCE` — only the
  decision crossed onto the user surface, which is why `Config.stream` is now a deep merge of the
  two halves the way `session` already was. A plain spread would have dropped the operator's value
  and reverted it on the next restart; `display.test.ts` pins that, since it is the third feature
  to walk into that trap.

### Added

- **`/setting stream on|off`.** `stream` used to be refused by name with a reason that was not even
  true of it ("not in config.yaml at all — frozen in the code"), which was correct for the
  throttling knobs and wrong for the one field an operator actually decides. It is a fifth editable
  setting now, `live` like the default agent: `TurnRunner` resolves the delivery mode per turn, so
  the next reply uses the new value with no restart and a turn already in flight finishes as it
  started.

### Fixed

- **`agent-anywhere --version` reports the version that is actually installed.** It was a string
  literal and had been wrong for four minor releases — a 0.11.0 install answered `0.2.0`. That is
  worse than having no flag, because it is the first thing you check when a deployment misbehaves:
  it sent an investigation of a live daemon looking for a stale install that did not exist. The
  uniagent image had already worked around it by asserting on the installed `package.json` instead,
  with a comment noting that `--version` "will always pass". Now read at runtime, correct both as
  `dist/cli.js` and under `tsx src/cli.ts`.

## [1.0.0] - 2026-09-05

### Fixed

- **A long reply is no longer truncated where the platform stops accepting edits.** Feishu/Lark
  caps in-place edits at 20 per message and then answers `230072` forever, and streaming a reply
  spends one edit per flush — so any answer past roughly twenty flushes hit the cap mid-delivery.
  What followed was worse than the cap itself: the buffer treated the rejection as a rate limit,
  backed off, "degraded", and on the final flush — the one carrying the complete answer plus footer
  — re-edited that same dead message, swallowed the error, and reported the turn complete. The user
  was left with a reply cut off mid-sentence, a ✅ on it, and no indication anything was missing.
  Observed twice in one evening on a 4.7k-character answer, of which 1.5k arrived.

  The delivery layer now models **one logical reply as an ordered run of messages**, only the last
  of which is still edited. A message is *sealed* — immutable, never touched again — when it fills
  `maxMessageLength`, when its edit budget is spent, or when the platform refuses an edit; in all
  three cases the sealed text counts as delivered and streaming continues into a fresh message.
  Because the length limit and the edit budget are now the same concept ("this message can take no
  more"), `sealedText + open.text` is always exactly what the user can see: nothing is re-sent and
  nothing is lost. Overflow chunks also stream as they arrive instead of waiting for turn end.

  Two things had to exist for that to work. Platforms declare their cap as a capability
  (`maxEditsPerMessage`; Lark: 20), so a message is sealed *before* the platform starts refusing
  rather than after a wasted round trip. And a rejection that means "this message is finished" is
  now a distinct type (`MessageNotEditableError`, translated from Lark's `230072` in the profile)
  instead of being indistinguishable from a rate limit — a distinction only the platform can draw,
  and the one the old code was missing. Genuinely transient failures still back off and keep the
  message open; the final flush, having no later flush to recover, seals and sends the remainder
  rather than leaving the answer truncated.

- **Tool bubbles no longer freeze mid-run on the same cap.** `accumulate` grouping spends an edit
  per progress update, so a ten-tool turn is exactly Lark's twenty. Past that the bubble stopped
  updating with no error in channel — a turn doing real work looked hung. Bubbles now seal on the
  same rule, carrying the lines the frozen bubble doesn't already show (still running, or finished
  since the last write) into a new bubble; lines already fully rendered are dropped rather than
  repeated, so bubbles don't grow by the whole history.

- **Outbound failures log their actual reason.** Satori's `MessageEncoder` throws an
  `AggregateError` whose own `.message` is empty, with the real HTTP error inside `.errors`, so the
  tool-bubble path printed `[turn] render side effect failed:` and nothing after the colon. The
  unwrapping that the stream sink already did is now shared (`describeOutboundError`) and used
  everywhere outbound errors are logged. A sealed message logs as ordinary bookkeeping rather than
  as an error, since the writer continues in a new message.

- **The config-path tests pass on a Windows checkout.** They asserted literal POSIX strings against
  values built with `path.join`/`path.resolve`, so they only ever tested that the suite was running
  on POSIX — and since `npm run release` gates on `npm test`, two green-elsewhere failures blocked
  cutting a release from Windows entirely. The precedence rules they exist to pin are unchanged.

### Removed

- **`stream.maxFailuresBeforeFallback`** and the "degrade to whole-message send" path it drove.
  Sealing replaces it, and it cannot express what the failure actually was. Configs carrying the
  key are unaffected (unknown keys are ignored).
- **`stream.mode`** (`auto` | `edit` | `chunk`) — read by nothing. How a reply is delivered follows
  from what the platform can do (`editMessage`, `maxMessageLength`, `maxEditsPerMessage`), not from
  a preference, and a knob that silently does nothing is worse than no knob.
- **The streaming cursor** (`StreamBufferOptions.cursor`) and `StreamSink.delete`. The cursor had
  already been hardcoded off; both existed only to service the degraded path's "delete the frozen
  preview, or edit the cursor off it" cleanup, which no longer exists — a sealed message is
  complete text, not a frozen preview needing repair.

## [0.11.0] - 2026-09-04

### Added

- **`/setting` changes config.yaml from chat.** A handful of fields in that file are not
  deployment plumbing at all but a decision someone makes on a Tuesday — which agent answers by
  default, what model an agent should start with, how long an idle conversation keeps its process —
  and they were paying the heaviest edit cost in the product: reach the machine, edit YAML, restart
  the daemon, and lose every resident agent child in the process. Those are exactly the fields that
  stayed on the user surface instead of being frozen into `EXPERIENCE`, so the cost was falling on
  the values most likely to be adjusted.

  Four are editable (`routing.default`, `agents[].model` per agent, `session.idleTimeoutMs`,
  `session.scope`), as a two-level button menu where a message's buttons can be replaced, and as
  `/setting <key> <value>` on every platform. Every answer states **when** the change lands,
  because they differ: three take effect immediately, a model applies to the agent's next session,
  and the scope is written but deliberately NOT applied — changing what counts as one conversation
  while conversations are open would silently re-identify all of them, so the file is updated and
  the restart is named.

  What it will not touch is refused *by name*, with the reason, rather than answered "no such
  setting": `access.allowFrom` (one wrong value locks you out of the surface you would use to fix
  it), credentials (a chat log is the wrong place for them), `routing.pipeline` (a rule is a
  structure, not a value a picker can offer), and the frozen `EXPERIENCE` knobs (not in the file at
  all). A real config key deserves better than being told it does not exist.

  Writes go through the YAML document, so comments, key order, hand-edited siblings and `${VAR}`
  templates survive byte-identical, and a change is validated against the whole config *before* the
  file is touched. That check is the point rather than a precaution: this is the only command that
  writes the file the daemon needs in order to start, so a value that parses but fails the schema's
  cross-checks would otherwise leave a deployment that runs until someone restarts it.

## [0.10.0] - 2026-09-04

### Changed

- **A channel entry now covers that channel's topics** — in `chat.channels`,
  `freeResponseChannels` and `ignoredChannels` alike. All three matched the textual address
  exactly, and a whole-chat entry deliberately excluded the chat's lanes on the grounds that each
  topic is its own conversation. That reasoning is right about identity and wrong about these
  lists, which a Feishu **topic-mode group** (话题模式群) makes unmissable: there a topic id is
  minted per root message, so the chat id — the only thing an operator can write down — matched
  nothing at all. `channels: [oc_xxx]` silenced the bot in the very chat it had just been pointed
  at, `freeResponseChannels` could not exempt it from the @mention rule, and `ignoredChannels`
  could not block it; all three failed by doing nothing, which is the hardest failure to read.
  It also disagreed with routing, where `when.channelId` has always covered a channel's topics.

  `<chat>/<thread>` still names exactly one lane, and nothing else changed. What is no longer
  expressible is "the chat root but not its topics" — nobody asked for it, and the previous
  spelling of it was a trap.

### Fixed

- **A Feishu rich-text message is no longer ignored outright.** adapter-lark's decode handles
  `text/image/audio/media/file` and lets everything else fall off the end of the switch, so a
  `msg_type: 'post'` — what a Feishu client sends whenever the message mixes formatting or embeds
  an image — reached the gateway with empty content and was dropped by the inbound gate as
  `empty`. From the chat it looked like the bot ignoring a message that had just @-mentioned it,
  and there was nothing in the log to contradict that reading.

  The profile now rebuilds the content in the same `internal/session` hook that already learns
  topic reply anchors, and two parts of that are load-bearing rather than tidy. A post's `at`
  carries a placeholder (`@_user_1`) with the real `open_id` in the message's `mentions` array, so
  passing it through verbatim would have left mention detection permanently blind in rich text —
  the message would still be dropped in any group that requires a mention. And embedded images
  are addressed exactly like a standalone image message, so they download through the same route
  as everything else, names included. `sticker`, `share_chat` and `merge_forward` are still
  empty, now on purpose and with the reason recorded: Feishu's resource API excludes 表情包, and a
  forwarded bundle needs another API call to read.

- **A Feishu image or file now reaches the agent instead of a "failed to download" line.**
  adapter-lark decodes inbound media into `internal:lark/<selfId>/im/v1/messages/…/resources/…`,
  satori's internal-URL form, which nothing but the bot can resolve — while the daemon's
  downloader speaks http(s) only, deliberately, because it re-validates every hop of a
  user-controlled URL against SSRF. So every attachment anyone sent the bot on Feishu was
  swallowed by that guard and reported as a network flake. Lark is the only one of the eight
  adapters that does this (the other seven emit public https links), and now the only one with a
  `fetchAttachment` override: a profile gets first refusal on each URL and fetches its own
  through the authenticated client, returning `undefined` for anything it does not own.

  The SSRF model is unchanged — those requests go to the endpoint the operator configured, with
  the bot's own token, and the only user-controlled part is a path segment, validated against
  Feishu's id alphabet so a crafted event cannot address a different endpoint. The size cap still
  applies, enforced after the fetch because that route reports no `content-length` to pre-check.

  Two things had to be recovered along the way, because a Feishu attachment declares neither a
  name nor a mime type anywhere the adapter surfaces. The filename comes from the raw event body
  (a `file` message states it; the profile caches it by `file_key` in the same `internal/session`
  hook that already learns topic reply anchors), and for an image — which has no name at all —
  the extension and mime are sniffed from the leading bytes, since the adapter's binary route
  discards the response headers. Without an extension the agent receives a blob it cannot open,
  and guessing `.jpg` for a png is worse than looking. A text file sent on Feishu is now inlined
  into the prompt like anywhere else, because the readable-text decision is re-taken once the
  name is known.

## [0.9.0] - 2026-09-04

### Added

- **The footer now names the model on `agy` conversations.** agy reports the model it is serving
  exactly once, in its `init` frame, and that field was being read for the conversation id and
  thrown away — so the footer fell back to `agents[].model`, i.e. whatever the operator had typed
  in config, and printed nothing at all when they had typed nothing. The value is now stored on the
  session and replayed at the top of every turn (the footer reads a per-turn record, so one emit at
  spawn would have named the model on the first turn and on no other). What the footer prints is
  now agy's own resolved id, including the default nobody configured.

  Still unsupported, and deliberately: `/model` on an agy conversation answers "not supported"
  rather than opening the menu. agy exposes no model selector and no way to switch in-process — the
  model is fixed by `--model=` at spawn — so a menu there could only offer a switch it cannot make.

### Fixed

- **`/context` no longer promises numbers that are never coming.** A harness reports context only as
  ACP `usage_update`, and opencode sends one only for a model whose context window it knows. A model
  declared in a custom `provider` block with no `limit.context` therefore reports nothing at all —
  not a zero window, no notification — so the footer's context segment stayed absent and `/context`
  answered "No context numbers yet — they arrive with the first reply. Send a message, then
  /context." forever, sending the user in a circle. That sentence is still right before the first
  turn; after one has finished, `/context` now says the numbers were not reported and, on opencode,
  names the fix (a `limit` block on that model in `opencode.json`). Verified on opencode 1.18.27 in
  the same session: `opencode/big-pickle` reports `{used, size: 200000}`, a custom-provider model
  reports nothing, and adding `limit.context` to it makes the numbers appear.

- **`/new` and an agent rebind now clear the context snapshot they invalidate.** `/context` reads
  the last `usage_update` and labels it with the currently bound agent, but the snapshot outlived
  both resets — so after `/new` it reported the size of the context that reset had just destroyed,
  and after `/oc` it showed claude's numbers under opencode's name. Both now forget it, which puts
  the pair back in the honest empty state until the new context reports its own.

## [0.8.0] - 2026-09-04

### Added

- **`/stop` ends the current turn without ending the conversation.** Until now the only way to stop
  a running agent from chat was `/new`, which also destroys the context — so "stop, that's the wrong
  file" cost you the whole conversation you were in the middle of. The only other interrupt,
  `inbound.interruptOnNewMessage`, fires as a side effect of sending another message rather than
  because anyone asked. Everything underneath was already there (`AgentSession.abort()`, the
  per-turn `AbortController`, TurnRunner's interrupted branch that keeps the partial reply and drops
  the footer); what was missing was a way to ask for it. `/stop` is intercepted before the merger,
  like `/new`, so it works mid-turn, and it answers with what it actually stopped — a turn, a
  message still inside the merge window, or nothing — because one ack for all three outcomes is how
  a stop command earns a reputation for not stopping anything. The queued backlog is dropped rather
  than promoted to the next turn: those messages were written for the turn being stopped.

- **Idle conversations release their agent process (`session.idleTimeoutMs`, default 1 h).**
  `scope: per_thread` means every topic anyone has ever messaged holds its own resident harness
  child, and a Claude Code process is hundreds of MB; nothing ever reclaimed them, so the only
  ways down were `/new` and restarting the daemon. The hooks for this had been sitting unused since
  the beginning — `InboundMerger.onIdle` documented as "drives idle reclaim" and never wired,
  `PendingAsk.conversationId` documented as an "eviction-guard anchor" with no eviction to guard
  against.

  What made it safe to finish is that reclaim is no longer a new risk: since `conversations.json`
  started recording each agent's own session id per conversation, killing a child and resuming it is
  exactly what a **daemon restart** already does to every conversation at once. This does it to one
  idle conversation on purpose. The conversation, its binding, its token, its stored session ids and
  even the session handle (and with it a runtime `/model` choice) all survive; the next message
  respawns the child and resumes through the harness's own reload — verified available on all three
  harnesses in use (claude and opencode advertise ACP `loadSession`, agy replays `--conversation`).

  It fires only when the conversation is quiet past the deadline AND the merger is idle AND the
  daemon holds no pending `ask` for it AND the session says it can resume. The second condition is
  the one that matters most: the clock starts when the last turn ENDED, so a task that runs for
  hours — subagents included — is never a candidate while it runs. A reverse command counts as
  activity too, so an agent that finished its turn and left a background job reporting through
  `agent-anywhere send` keeps its child. A harness that cannot reload a stored session is left
  resident and said so once, rather than having its context quietly restarted.

## [0.7.0] - 2026-09-04

### Changed

- **`/model` now opens the menu on `claude` too, instead of forwarding to claude's own.** It looked
  like the "a native spelling always wins" rule protecting claude's answer, and it was not: probed
  live against claude-agent-acp 0.58.1, the adapter does not advertise `model` among its commands
  at all, so a forwarded `/model` was a plain prompt — it spent a turn and printed
  `Current model: Opus 4.8 (1M context) … Usage: /model <name>`, text you then had to type against.
  The same session exposes the selector as a config option that `session/set_config_option`
  switches, which is exactly what the gateway already does for opencode. So `/cc` conversations get
  the same tap-to-switch menu, and no turn is spent. The trade: only the options the protocol lists
  can be picked, while claude's prose names a few more aliases (`opusplan`, `best`, a full model
  id) — those stay reachable through `agents[].env.ANTHROPIC_MODEL`.

- **The footer names the model that is running, with its version.** It read `opus[1m]` — the alias
  from `ANTHROPIC_MODEL`, which says which family answers but not which release, so it looked
  identical before and after Opus 4.8 shipped. Neither the option id nor its display name ("Opus")
  carries a version; the description does, verbatim: `Opus 4.8 with 1M context · …`. The footer now
  reads `opus-4-8`. `[1m]` drops out with it and nothing is lost — the context segment beside it
  already reads `/ 1M`, so the qualifier was saying twice what one number says. A `default` pin
  resolves the same way, to whatever it currently points at rather than to the word "default".
  Harnesses whose descriptions state no version (opencode writes none) keep the previous label.

## [0.6.0] - 2026-09-04

### Added

- **`/model` is now a menu you can page through.** It could already show the live model and
  switch by substring, but not *list* — the list is what a phone user actually wants, and
  93 models was past both the 25-button cap and what reads as a message. A bare `/model`
  now posts the models the agent offers as buttons, opening on the page holding the current
  one (naming what you are on is half the question), with ◀ ▶ turning the page on the same
  message and a tap switching the model. `/model <part of a name>` is untouched and still
  works everywhere, including the platforms that get no menu.

  A menu is a snapshot and a click is a later event, so everything the menu assumed is
  re-checked before anything switches: the conversation still exists, the same agent still
  answers it, there is a live selector, and — the load-bearing one — the harness still
  offers that model. The harness can rebuild its list mid-session, and a button index
  resolved against a stale list would otherwise switch to a model nobody saw. Each of those
  gets its own sentence on the menu itself; none of them is a silent no-op, because on a
  button that is indistinguishable from a dead one.

  Reaching Discord, Telegram, Slack and Lark, where a sent message's buttons can be
  replaced. QQ and LINE have no message-edit endpoint at all, so a menu there could never
  be paged *or* retired — its buttons would outlive their own ack — and they keep the text
  answer, which was always the complete answer rather than a degraded one.

### Fixed

- **A mid-session model switch no longer leaves `/model` describing the old one.** The
  harness reports `config_option_update` when its model changes, and the daemon forwarded
  the new name to the footer but dropped the option list that came with it — so the
  session's own selector kept reporting whatever `session/new` had said. The footer was
  right and everything reading the selector was one switch behind.

## [0.5.1] - 2026-09-03

### Fixed

- **An agent command for a harness you never configured no longer dies silently.** `/agy hi`
  in a deployment with no `harness: agy` agent resolved to nobody, so the prefix survived and
  the message reached the *bound* agent still spelled `/agy hi` — which ran it as one of its
  own slash commands, found nothing, and answered "ran a command, but there was no output to
  display". The gateway now names the gap ("No agy agent is configured here…") and runs no
  turn. A `when.command` rule and a configured harness both still outrank the check, so an
  operator's own alias is untouched. Startup also logs the agent commands config produces and
  the agent each selects, which is where the cause is visible.

### Changed

- **One phrasing for every agent command in the platform menu.** `/agy` read "Switch this
  conversation to agy" while `/cc` and `/oc` read "Switch to claude — alone, lists its own
  commands", so a single menu described the same action two ways. All of them now open with
  `Switch to <harness>`, and only a harness that has a command list to show keeps the clause
  about the bare form.

## [0.5.0] - 2026-09-03

### Added

- **`/model` and `/context` now work on opencode**, answered by the gateway itself. Both
  were in the generic vocabulary only to be *refused* there, because the translation layer's
  single mechanism is text: it rewrites `/x` and hands it to the agent as a prompt, so a
  capability the harness exposes over the protocol instead of as a slash command reads as
  "not supported". Probed live against opencode 1.18.18, both are there — a
  `usage_update {used, size}` on every turn, and a `model` select carrying its full 93-model
  list that `session/set_config_option` switches.

  `/context` prints the last snapshot the agent reported, in the same format the footer uses.
  `/model` shows the live model, and `/model <substring>` switches it for that conversation —
  93 models is far past a button menu's 25 and past what is readable as a list, but
  `/model sonnet-5` is one thumb-typed token. An ambiguous query lists the candidates instead
  of guessing. The choice survives the agent child being rebuilt — a crash or an idle eviction
  re-applies it over `agents[].model` on the next `session/new` — and is cleared by `/new` or a
  rebind to another agent, like the rest of that agent's per-conversation state.

  A native spelling still wins: `/model` on claude reaches claude's own model UI. And the
  fallback is a harness LIST rather than a flag, populated only from what was probed — `agy`
  speaks no ACP, so it keeps the honest "not supported" instead of a "no numbers yet" that
  would never resolve.

- **A Feishu topic (话题) is its own conversation.** Lark was the one platform with a real
  thread model that agent-anywhere flattened: the profile reported no lane, so every topic in
  a chat collapsed onto the chat root — one session, one agent binding, and every reply posted
  outside the topic that asked for it. Topics now behave exactly like Telegram topics and Slack
  threads: their own conversation key under `scope: per_thread`, their own `/oc` binding, the
  participated-thread mention exemption, and an address (`<chat>/<thread>`) that
  `chat.channels`, `freeResponseChannels` and `--channel` all accept.

  Getting *into* one is the awkward part, and worth writing down: Feishu's send API has no
  `receive_id_type` for a topic, so a message can only enter by replying to another message
  already inside it. The profile therefore remembers a reply anchor per topic — learned from
  every inbound message and refreshed by every send — and looks one up through the thread
  history API only on a cold miss (a fresh daemon, or a reverse command aimed at a topic
  nobody has spoken in yet). A topic with no reachable anchor raises an error naming it rather
  than quietly posting the agent's answer to the whole chat. `sendFile` carries the lane twice
  on purpose: the adapter's encoder posts the caption and the file separately and drops the
  quote in between, so a single one would thread the caption and leak the file.

  `autoThread: perTurn` works on Lark too. Unlike Telegram, Feishu cannot name an empty topic
  — one exists only once a message opens it — so the thread name is posted as that opening
  message.

### Fixed

- **Clicking a harness-picker button did nothing.** `/oc` posted opencode's commands as
  buttons and a tap produced no reply, no reaction, and no change to the menu. Two causes,
  both silent by construction:

  Telegram's Satori adapter sets `session.messageId` to the **`callback_query` id** on a
  click — not a message id at all — while `ButtonInteraction.messageId` is contractually the
  message the button is on. The click ack (`→ /customize-opencode`) therefore edited a
  non-existent message, 400ed, and was swallowed by the best-effort `catch`; the same bogus
  id also killed the 👀/✅ lifecycle reactions on the resulting turn. So the command *did*
  run, with every trace of it having run suppressed. The ack now edits the menu message
  captured at send time, and the Telegram profile corrects the field at the source
  (`rawCallbackMessageId`).

  Second, a click on an expired menu — the one-shot already consumed, or the daemon restarted
  since (`pendingPicks` is in-memory) — returned silently, which from the chat looks exactly
  like a dead button. It now says so.

  The whole click path had no test coverage; it does now (`daemon/picker-click.test.ts`).

## [0.4.0] - 2026-09-03

### Changed (breaking) — the registered command menu

- **Agent commands are short, and they work without config.** The per-harness entries
  registered into the platform menu were the harness enum value leaking into the UI
  (`/claude`, `/opencode`) — long to type on a phone, and *inert*: they only switched agents
  if an operator had separately hand-written a `when: { command: oc }` rule, so on a fresh
  install tapping one forwarded the literal text `/opencode` to whichever agent was bound.

  They are now `/cc`, `/oc`, `/cx`, `/gm`, `/agy` (claude, opencode, codex, gemini,
  Antigravity), and the daemon resolves them itself — each selects the first configured agent
  of that harness. A hand-written `when.command` rule still outranks the built-in table, so
  existing configs behave exactly as before. The full harness name (`/opencode`) is still
  accepted when typed; it is simply no longer registered, so it costs no menu slot.

- **A bare agent command now opens that harness's own command menu.** `/oc <prompt>` switches
  and asks, as always; `/oc` alone switches and then lists opencode's own commands as buttons
  — which is what `/opencode` used to do. This replaces two things with one: the old picker
  refused to run unless the conversation was *already* on that harness, answering "does not
  apply here, switch with `/<agent>` first" — advice the command itself can now just follow.
  A harness that reports no command list (`agy`) confirms the binding instead of posting an
  empty menu.

  Supersedes 0.3.0's "a bare `/oc` rebinds and says so instead of acking usage".

- **`/agy` is registered.** It had been skipped entirely on the grounds that it reports no
  command list, which conflated "has a menu to show" with "is worth naming" — leaving the one
  harness a user most needs to reach by name with no entry at all. Those are now separate
  fields on the harness table.

  Supersedes 0.3.0's note that agy "gets no `/agy` picker entry": it has a registered command
  now, and only the menu half remains unavailable.

### Added

- **`/help`** — lists every command this gateway understands: its own (`/new`, `/clear`,
  `/help`), one line per configured agent, and the generic vocabulary **filtered to what the
  agent answering right now actually supports**, so it never advertises a `/compact` that the
  next tap will refuse. Built from the same tables that drive registration, so the help text
  and the platform menu cannot drift apart. Answered by the gateway; a harness's own `/help`
  remains one tap away inside its agent-command menu.

## [0.3.0] - 2026-09-03

### Changed (breaking) — conversations, topics and agent binding

- **A topic is now a conversation, and the agent answering it is sticky.**

  The bug: in one Telegram topic, `/oc hi` was answered by opencode and the very next plain
  message by claude — two agents, two empty contexts, one place. The agent id led the session
  key (`<agentId>:<platform>:c:<channel>`) *and* `routing.pipeline` was re-resolved on every
  message, so a follow-up matching no rule fell through to `routing.default` and computed a
  different key. The agent was part of a conversation's identity rather than a property of it,
  so a sticky binding was not expressible.

  Now the key carries no agent. A `when.command` rule (`/oc …`) **binds** the conversation;
  every plain message after it stays with that agent until someone types another `/<agent>`.
  Config chooses a conversation's first agent, the user chooses it thereafter. A bare `/oc`
  rebinds and says so instead of acking usage.

- **Switching agents never restarts your work.** `conversations.json` records, per conversation,
  the bound agent *and* each agent's own session id — so `/oc` → `/cc` → `/oc` resumes
  opencode's existing thread rather than starting the task over. The gateway is a chat client in
  front of the agent; only an explicit `/new` discards context, and it clears the whole
  conversation. Pre-existing `sessions.json` is migrated on first start, so nothing in flight
  restarts on upgrade.

- **`session.scope` now defaults to `per_thread`** (was `per_channel`), and `per_thread` finally
  does something: it was a verbatim copy of `per_channel`, differing only in a letter of the key.
  A Telegram topic / Slack thread / Discord thread is its own conversation, with the channel root
  separate. Set `scope: per_channel` for the old folding behavior.

- **Conversation identity is a struct, not a string.** A topic is a `(channel, thread)` pair, but
  the domain had one opaque `channelId`, so the pair was smuggled through as `"<chat>:<topic>"` —
  built in 5 places, decoded in 17, validated in none. Every path that forgot to decode sent to
  the wrong place, and because Telegram truncates a malformed `chat_id` leniently in private
  chats, half those failures were silent successes. `ConversationRef`/`ConversationAddress`
  replace it; the string form survives only for the `--channel` flag (`<channel>` or
  `<channel>/<thread>`) and the store key, each with one validating parser.

- **The platform seam is one method.** `isDirect`, `isThread`, `inboundChannelId` and
  `decodeChannelKey` collapse into `resolveConversation`, called on all three inbound paths, so a
  profile can no longer wire messages and forget button clicks, and the routing view cannot
  disagree with the addressing.

### Fixed (each previously reachable)

- **Slack threads were invisible inbound.** `isThread()` hardcoded `false` while the outbound side
  emitted thread addresses, so a reply typed inside a thread was routed as channel traffic — and
  answered in the channel.
- **`when.serverId` never matched.** `guildId` was never populated on the message path.
- **A native slash could route differently from the same text typed by hand.** The synthesized
  message carried no `isDirect`/`isThread`/`guildId`, so `when.chat` always read `group`.
- **`when: {chat: private}` had stopped matching** during this refactor (config says `private`,
  the domain says `direct`); caught by a ported test, fixed with an explicit mapping.
- **Telegram `create-thread` from inside a topic** sent `chat_id: "-100123:99"` (400 in a group,
  silent truncation in a DM) and returned a malformed triple whose lane parsed to `NaN`. It was
  the one outbound path that never decoded, and had no test.
- **`autoThread` opened a thread and abandoned it**: the user's first reply inside started a
  fresh, empty conversation. The thread is now adopted by the conversation that opened it.
- **`sendFile` received a decoded channel while every sibling received an undecoded one** — a
  contract mismatch waiting to be got wrong.

### Added
- **`harness: agy` preset**: Google's Antigravity CLI (the Gemini CLI successor). Unlike every
  other preset, `agy` has no ACP mode at all, so it is driven over its own documented headless
  `stream-json` protocol by a sibling runtime (`daemon/agent-agy.ts`) implementing the same
  `AgentFactory` contract — streaming, tool bubbles, multi-turn context, post-restart resume
  (via `--conversation`) and interrupt all behave as they do for the ACP harnesses. Requires the
  `agy` CLI on PATH; auth reuses its own Google sign-in from the OS keyring.

  Its own slash commands are disabled by default (`--disable-slash-commands`): in stream-json
  mode a CLI-answered slash such as `/model` aborts the entire session, which chat users would
  trip constantly. Pass `args: ["--disable-slash-commands=false"]` to opt back in. All default
  flags are overridable through `args`. Consequently agy gets no `/agy` picker entry and the
  generic vocabulary reports "unsupported" for it, rather than forwarding a name that would
  kill the session.

  Note: Google's FAQ states that third-party access to Antigravity violates its Terms of
  Service. This harness calls only agy's official headless interface and never handles
  credentials, but the daemon is still a non-Google client driving the account.

- **Text command routing**: `routing.pipeline` rules with `when.command` now match the leading
  `/name` of plain message text, so command routing works on every platform — no native
  slash-command support needed (previously `when.command` could never match: the command field
  was never populated on the message path). A rule that matches via `command` consumes the
  prefix — the routed agent receives only the rest of the message — and a bare `/name` is
  acked with a usage hint instead of starting an empty turn. Commands matching no rule still
  pass through to the agent untouched (`/model` etc. keep working).

- **`harness: opencode` preset**: OpenCode via its native ACP mode (`opencode acp`, per the
  ACP registry's official launch spec). Requires the opencode CLI on PATH; auth reuses its
  own login state.

- **DingTalk (钉钉) platform** (`type: dingtalk`, via `@satorijs/adapter-dingtalk`): org-internal
  robot with Stream mode by default (outbound WebSocket — no public callback URL), or
  `protocol: http` for a classic webhook. Outbound messages are `sampleMarkdown`, with agent
  CommonMark pre-rendered to DingTalk's markdown subset (tables→bullets, block regrouping for
  the "single `\n` is not a line break" quirk) and sent past the adapter's escaping encoder.
  DMs and group chats both work (group messages reach a robot only when @-mentioned, which the
  mention gate honors). No edit/reaction/typing/buttons — streaming degrades to chunked sends,
  and `ask` is unavailable on this platform.

- **Contributor documentation**: a root `AGENTS.md` (conventions, layering rules, security
  invariants, and an index) plus a `README.md` per module — `src/config`, `src/core`,
  `src/platform`, `src/daemon`, `src/ipc`, `src/commands`, `scripts`. Deliberately distributed
  rather than one file: each module's contract, invariants and extension steps live next to the
  code they describe, so a coding agent reading one module gets its rules without the other six.

### Fixed
- **noEdit platforms never delivered any reply** (DingTalk/QQ/LINE/WeCom — every platform without
  in-place message editing): the StreamBuffer's degraded path recorded mid-stream accumulations as
  "already delivered" without sending them, so the end-of-turn whole-send was skipped as
  "unchanged" and the agent's reply silently vanished. Masked in tests by the old non-empty
  streaming cursor (production streams with `cursor: ''`, making the mid-stream and final renders
  identical). The agent replied every time — the buffer just never flushed it.

- **`harness: codex` actually works now**: it spawned `codex acp`, but the codex CLI has no such
  subcommand — "acp" fell into the TUI, which dies headless with "stdin is not a terminal", so
  every turn failed with "ACP connection closed". The harness now spawns Zed's
  [codex-acp](https://www.npmjs.com/package/@zed-industries/codex-acp) adapter (a declared
  dependency, platform binary resolved directly); auth reuses the codex CLI's own login state.

### Changed
- ~~**Session keys are agent-qualified** (`<agentId>:<platform>:c:<channelId>` …)~~ — superseded
  within this same unreleased cycle, and never shipped. Agent-qualifying the key did stop one
  agent from capturing a channel forever, but it made the agent part of a conversation's
  *identity*: `/oc hi` and the plain message after it became two conversations in one place. The
  conversation refactor above keeps the property that motivated it (two agents in one channel
  don't share a context) while making the conversation, not the agent, the thing being named.

## [0.2.0] - 2026-07-10

### Added
- **Config reference for agents** (`skill/references/config.md`): a complete, schema-accurate
  reference for `config.yaml` (per-platform credentials, routing, session scopes, `access.allowFrom`,
  and what is deliberately not configurable), so an agent can safely edit the gateway config when
  asked from inside the chat.
- **README "Agent skill" section** with a one-line install via
  [vercel-labs/skills](https://github.com/vercel-labs/skills):
  `npx skills add https://github.com/l0ng-ai/agent-anywhere/tree/main/skill -g`.

### Changed
- **Bundled skill rewritten** against the actual implementation: per-command output contracts
  (`messageId` returns, TOON examples, `count: 0` empty state), platform capability fallbacks
  (`reply` degrades to a plain send; `edit-message`/`create-thread`/`ask` fail with
  `unsupported operation`), error handling (`error:`/`help:` on stdout), and a new
  gateway-diagnostics section (`doctor`, config editing, why the agent must never restart
  the daemon it runs inside).
- README reordered install-first: Features → Quick start → Agent skill → Platforms → Configuration.

## [0.1.0] - 2026-07-10

### Changed (design)
- **Removed the per-agent `permission` policy.** The daemon is a headless ACP client and now
  auto-approves every tool call — agents always run with full tool access. Restricting tools, if
  wanted, is delegated to the harness (via `agents[].args`/`env`). The daemon's only access control
  is `access.allowFrom` (who may trigger an agent at all).

### Security
- **Access-control warning.** Because agents always have full tool access, an empty `access.allowFrom`
  means anyone who can message the bot can drive them. `agent-anywhere start` and `agent-anywhere doctor` now warn
  loudly on an empty allowlist (non-blocking); the setup wizard prompts for it.
- **SSRF: redirects are re-validated.** Attachment downloads follow redirects manually and re-run the
  private-address guard on every hop (previously a 3xx could bounce past the initial check).
- Proxy URLs are credential-redacted before logging; session tokens are compared in constant time.

### Changed (agent CLI / AXI)
- **Command surface tightened.** Removed `send-image` (it was a strict subset of `send-file` — both
  encode via `h.file`, so the image never inlined) and `typing` (the daemon already maintains a typing
  keep-alive for the whole turn, so a manual command was dead weight). Added `edit-message <id> <text>`
  so an agent can update a message it sent earlier (e.g. a progress line) in place.
- **`agent-anywhere` with no args now runs `doctor`** (read-only self-check), not `start` — a bare invocation
  shows live state instead of accidentally launching a daemon (AXI §8). `start` is now an explicit
  subcommand; `doctor` prints a `bin:`/`description` header (AXI §10). Start the daemon with `agent-anywhere start`.
- **`fetch-messages --fields attachments`** now emits a separate `attachments[]{messageId,type,url,name}`
  table so an agent can download referenced images/files by URL; a hint flags messages that have
  attachments when the column wasn't requested.
- **Reverse commands now speak [TOON](https://toonformat.dev/) on stdout** (via `@toon-format/toon`),
  not raw JSON — ~40% fewer tokens for the agent that reads them. Conversion happens only at the CLI
  output boundary (`commands/reverse.ts`); the daemon keeps speaking plain JSON over IPC.
- **`fetch-messages` output is now AXI-shaped**: a minimal default schema (`messageId,userId,content`),
  opt-in extra columns via `--fields` (validated; `attachments` renders as a count), per-row content
  truncation to 500 chars (with a count of how many were clipped), a `count` aggregate, paging/widening
  `help` hints, and a definitive empty state (`count: 0` + note) instead of an ambiguous `[]`.
- **Errors go to stdout, structured.** Reverse-command failures, unreachable-daemon hints, usage errors,
  and the top-level catch now emit a TOON `error:`/`help:` on stdout (commander's stderr is redirected),
  so the invoking agent can actually read and act on them. `create-thread`/`send-message`/`reply` etc.
  return actionable fields (`threadId` + a `--channel` hint; `messageId` for follow-ups).

### Added
- **Hung-agent watchdog** (`session.turnTimeoutMs`, default 10 min): aborts a turn after prolonged
  agent silence and reaps the subprocess, so a stuck agent can't pin a session forever.
- In-channel error notices: a failed turn now posts a readable reason, not just a ❌ reaction.
- Bot offline/disconnect/reconnect logging in the Satori adapter.
- Test coverage tooling (`npm run test:coverage` with thresholds), ESLint flat config (`npm run lint`),
  and a GitHub Actions CI workflow (typecheck + lint + test + coverage).
- Table-driven tests for the security-critical pure functions (SSRF guard, filename sanitizer,
  permission gate, IPC request parser, token registry) and the config security gate.
- `LICENSE` (MIT) and this changelog.

### Changed
- Removed dead type imports across platform profiles; tightened a few `let`→`const`.
