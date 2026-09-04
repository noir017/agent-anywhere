# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
