# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **The web UI can be installed as an app.** Chrome, Edge and Safari will now offer "install" or "add to home screen" rather than a bookmark, and what opens is a standalone window with no URL bar, its own launcher icon, and the status bar drawn in the app's own colour instead of framing it in white. The daemon serves a web app manifest and an icon — a `>_` prompt, which is what is on the other end — from three new routes alongside the page.

  Two decisions inside it are worth stating. There is **no service worker**, and one should not be added to make this work: Chrome dropped that requirement because the check was only ever a proxy for "has an offline story" and sites defeated it with empty fetch handlers, and a worker here would mean caching the app shell — which is served `no-store` precisely so that an upgrade cannot leave a stale copy behind. And the three routes are reachable **without signing in**, because a browser fetches them while deciding whether the site is installable, which is before anyone has signed in; a 401 there is indistinguishable from "not installable", with nothing in the UI to say so. They carry the configured title and a drawing, and the title is already in the `<title>` of the equally-open page.

  Every URL in the manifest is relative, so a daemon mounted under a sub-path by a reverse proxy still installs to the right place.

### Changed

- **Enter in the web UI's composer writes a newline; Ctrl/Cmd-Enter sends.** This is the inverse
  of the chat-app convention and is deliberate. The composer is most often reached from a phone,
  where there is no Shift key to hold down — Enter-to-send did not make a multi-line message
  awkward there, it made one impossible to type. What gets written into this box is prompts,
  which run to several lines more often than chat messages do, and losing a half-composed one to
  a stray Enter is the more expensive of the two mistakes. The shortcut is the same at every
  screen width rather than a narrow-screen special case: a send key that changes under you when
  the window is resized is worse than either choice on its own. The Send button's tooltip names
  the shortcut, since the keystroke is no longer the one people arrive expecting.

### Fixed

- **The web UI's drawer toggle is big enough to hit with a thumb.** On a narrow screen the `☰` in
  the chat header is the only way back to the topic list, and it was drawn at the desktop icon
  size — a 26×21 target, well under what every mobile interface guideline asks for. It is now a
  44px square with a larger glyph, and the header's vertical padding gives way to it, so the title
  bar goes from 42px to 49px rather than to 56.

## [1.21.0] - 2026-09-20

### Added

- **The web UI keeps its own copy of the conversation, so a restart no longer empties the page.** The daemon's transcript is memory and stays that way; what changed is that the browser now writes down what it has seen, in IndexedDB — one record per topic, a rotating 200 messages and 512KB each, 24 topics, evicted least-recently-written-first. Two things follow from it. A topic paints from the last visit before its stream has answered, which on a slow link is the difference between reading and waiting. And when the daemon comes back, the messages from before it went away stay on screen above a divider saying where they came from, instead of the room going blank under an apology.

  The part that makes this safe is not the storage, it is the key. Message ids are counted per process and start again at `w1`, so a restarted daemon hands out ids a cached transcript is already using — the first reply after a restart really is `w1` again. A sync therefore now carries an `epoch`, the daemon's generation, and the page keys every message by `<epoch>:<id>`. Cached messages from an older generation are *history*: they keep their place, no reconcile drops them, and their buttons are stripped, because the process that would answer them is gone and the id they name now means a different message. Cached messages from the CURRENT generation produce exactly the keys the sync produces, so the ordinary path reuses every node and writes no DOM at all — the cache is a head start, not a second source of truth. A browser with no IndexedDB (a private window, an old engine) loses the cache and nothing else.

- **A message typed in the web UI is on screen before the request leaves, and stays there if the request fails.** It used to be drawn only when the daemon echoed it back, so there was a visibly empty transcript for the length of the round trip — and on a POST that failed after its retries the text was simply gone: cleared out of the composer, never in the conversation, nowhere left to copy it from. The bubble is now local first: dimmed while the request is in flight, taken over by the echo when it arrives (the same DOM node, claimed by the send nonce, so nothing re-runs the fade-in or moves the scroll), and on failure edged red with **Retry / Copy / Discard** under it. Retry re-posts the original nonce, which the server already dedupes, so retrying something that actually landed cannot double it. A failed message survives a reload; its Retry does not, because the body it would re-send carries attachments as base64 and that does not belong in a transcript cache — the restored bubble offers Copy rather than pretending it can re-send files it no longer has.

### Fixed

- **The web UI's message cache no longer fills up with the same message.** Every streaming edit arrives as an upsert of one id, and the old per-topic cache appended each one instead of replacing it, so a single long answer could occupy most of the 40 slots a topic had.

## [1.20.0] - 2026-09-20

### Changed

- **The `codex` harness is no longer bundled, and now points at a different adapter.** Two changes that only make sense together. The adapter moved from Zed's `@zed-industries/codex-acp`, deprecated upstream, to `@agentclientprotocol/codex-acp`; and it stopped being a dependency of this package, so it is installed alongside the daemon the way `opencode` and `dsh` already are. The packaging half is the reason the migration is not free: the new adapter declares `@openai/codex` as an ordinary dependency, whose platform binary is ~284 MB unpacked, and nothing justifies putting that inside every `npm i -g agent-anywhere-cli` for a harness most installs never configure — particularly when the operator who *does* configure it has already installed and logged into the codex CLI by hand. Net effect for everyone not using codex: this package is 209 MB smaller. For everyone using it: one `npm i -g @agentclientprotocol/codex-acp`, which `doctor` now names when the command is missing.

  The old adapter was worth leaving behind on its own merits. Probed side by side against the same gateway: it advertised 6 commands to the new one's 42, reported no model list at all (so `/model` had only a stale selector two model generations old), had no equivalent of `/usage`, `/skills` or `/mcp`, and prefixed its first answer with `Model metadata for <model> not found. Defaulting to fallback metadata` — not on stderr, but inside the agent's message text, which is to say in the user's chat bubble.

### Added

- **`/usage`, `/compact`, `/mcp` and `/review` now work on codex, and `/context` and `/model` are answered for it.** The generic command table had nothing at all under `codex`, deliberately, because the adapter of the day could not be probed and a guessed native name is worse than an honest "unsupported". The new one can be, so the entries are a capture rather than a guess: `/usage` translates to codex's `status`, the rest keep their names, and `/context` and `/model` are answered by the gateway itself from `usage_update` and the session's `model` config option. Two holes remain and stay honest — `/doctor`, which codex has never had, and `/init`, which it *did* have until the new adapter dropped it.

  One asymmetry is worth knowing before you go looking for it: codex exposes reasoning effort as part of the model id (`gpt-5.6-terra[high]`), but only in a list the `/model` menu does not read, and feeding a suffixed id back is rejected outright. Effort is a `model_reasoning_effort` line in codex's own `config.toml`, and it has to sit above the first `[table]` header or TOML quietly makes it that table's key.

- **`/skills` lists codex's skills.** It read nothing for codex before, because the per-harness directory table had no entry for it and an absent entry degrades to an empty catalogue. The four directories now scanned were established by planting a uniquely-named marker skill under each candidate inside an isolated `HOME` and reading the adapter's own command list back — it publishes every skill as `$name` — rather than by assuming codex looks where claude looks. It does not: a marker under `~/.claude/skills` was ignored, while `.codex/skills` and `.agents/skills`, each at both the home and the project level, all came back.

  `.agents/skills` is the one that would have been missed by analogy and the one that carries the actual content. On the machine this was built for, `~/.codex/skills` holds only codex's six bundled skills — which this feature excludes on principle, since "the skills I installed" is what `/skills` answers — and all 25 real ones live in `~/.agents/skills`, the cross-vendor location the agy harness already scanned. A codex entry naming only the `.codex` paths would have reported an empty catalogue on a machine that visibly has skills, which is the confidently-wrong answer this feature was written to avoid rather than a smaller version of the right one.

### Fixed

- **The web UI shows your own message exactly as you typed it.** It used to run the operator's text through the same markdown renderer as the agent's, which is wrong for the one text on that page whose exact characters matter: what you send is a prompt, and the echo above the compose box is where you check what the agent actually received. Rendering hid the difference, and did it most visibly on numbered lists — "1. … 2. …" with a line in between that markdown does not read as a list item came back as "1. … 1. …", because the interruption ends the first list and the second one renumbers from the top. Your side is now escaped and shown verbatim, with its line breaks intact. Every other platform in the gateway already behaved this way; the web UI is the only one that renders its own inbound, so it was the only one that could disagree with the user about what they had sent.

- **A numbered list that resumes after an interruption keeps counting in the web UI.** The same renumbering, on the agent's side of the conversation, where it is not fixable by refusing to render: a numbered list broken by a paragraph, a code block or an indentation change is two `<ol>`s to any markdown parser, and the second one started at 1 regardless of what the agent wrote. It now carries `start`, so the numbers on screen are the numbers in the text.

## [1.19.0] - 2026-09-20

### Added

- **The web UI's sidebar can forget every topic at once.** A restart leaves the switcher full of rows that open onto nothing (see below), and deleting a dozen of those one `×` at a time is not a feature. *Clear all topics* sits in a footer under the list rather than beside the `+` in the header, because it is a misclick away from throwing every room away and a one-character icon next to "new topic" is not where that belongs. It confirms, then sweeps the list and lands in the fresh topic that replaced it, dropping the page's own per-topic caches and read marks with it — a cache left behind would repaint messages for ids the daemon has forgotten. What it deliberately does *not* do, exactly like the per-topic `×` it repeats, is end the agent sessions: their bindings in `conversations.json` outlive the rows. It clears a list.

### Fixed

- **A web UI topic from before the last restart opened onto nothing, and said nothing about it.** The topic list is a file and the transcript is memory, so a restart turns every older topic into a row that opens onto a blank panel — and a blank panel rendered faithfully is indistinguishable from a page that failed to load. That is how it was reported: the sidebar has history in it, clicking through shows nothing, and the event stream can be watched arriving with the transcript genuinely empty. Keeping transcripts across restarts is a different feature with different questions attached; what was wrong here was the silence. A sync for a room that holds no messages and whose last activity predates the running daemon now says so, and the page answers with a line explaining that transcripts are kept in memory only and that the agent still has its context — so the conversation reads as one that can be carried on rather than one that was lost.

## [1.18.1] - 2026-09-19

### Fixed

- **Entering a topic in the web UI went blank, then snapped the whole conversation into place.** Two things were wrong and they compounded. Nothing was shown while the first sync was in flight, so the panel was simply empty for however long the network took; and when the sync landed it emptied `#log` and rebuilt every message from scratch — which destroyed the scroll container along with its position, so even a topic already painted from the local cache flashed through blank on its way to looking identical. The transcript is now reconciled by id: a message that did not change is left alone (the paint writes nothing when the markup it builds matches what is already there), one that moved is moved rather than re-created, and only what the server no longer has is removed. In the gap before the first sync the panel holds message-shaped placeholders instead of nothing, so the real conversation replaces something of the same shape rather than appearing out of an empty box. New messages fade in over 180ms; both the fade and the placeholders' breathing are dropped under `prefers-reduced-motion`.

  A resync after a dropped connection no longer yanks the reader to the bottom either — which was invisible before only because the rebuild had already thrown their position away. Opening a topic still lands at the bottom, that being the one case where it is what you want.

## [1.18.0] - 2026-09-19

### Fixed

- **A question the agent asked with "select all that apply" could only be answered with one option.** The wire shape for a multi-select question was parsed correctly — `type: 'array'`, options under `items.anyOf` — and then collected with the ordinary one-tap question and sent back as a single-element array, so the model asked for several answers and was told one. The round is now a stateful bubble: every option carries its own checkbox, a tap toggles it and repaints the row, and a Done button sitting one index past the options resolves with everything ticked, in the order the agent listed them rather than the order they were tapped. Done with nothing ticked says so and leaves the question up — there is no answer to give, and doing nothing at all reads as the bot ignoring the tap. Because all of that rests on repainting buttons that are already posted, it happens only where the platform can replace them (Discord, Telegram, Slack, Lark, the web UI); on LINE and QQ the round stays one tap and the message says why, pointing at typing, which genuinely carries several answers since a typed reply travels under the question's own free-text field and the harness prefers it over the enum.

- **In the web UI, a button stayed greyed out for a second and a half after every click.** The page disables a button the moment it is pressed and re-enables it only when the message repaints, and message edits are deliberately held so a streaming reply is not re-broadcast on every flush. Those two are fine apart and wrong together: an edit carrying buttons is never streaming progress but always the acknowledgement of a tap — a menu page turn, a question being retired, a multi-select tick — so it is now sent at once. On a multi-select, where ticking and unticking land on the same button, holding it was not a delay but a broken control.

## [1.17.1] - 2026-09-19

### Fixed

- **A double quote in anything the web UI put inside an HTML attribute broke the element it was in.** The page's escaping helper set `textContent` and read `innerHTML` back, which escapes `<`, `>` and `&` — right for element content, and one character short for the inside of a double-quoted attribute, which is the other thing it was used for. A directory name containing a quote (legal on every filesystem this runs on) ended the new topic row's `title=` early and spilled the rest of the path into the tag; the same held for a slash command's description in the autocomplete. The helper now escapes the quote as well. Not a way in — everything it renders is the operator's own paths and their own command list, and agent output goes through `web-markdown.ts`, which never builds a tag from it at all.

## [1.17.0] - 2026-09-19

### Added

- **The web UI takes an image straight off the clipboard.** Ctrl-V (⌘-V) of a screenshot attaches it to the message being composed, which is the fastest way there is to show an agent what you are looking at — the alternative was saving the screenshot to a file first so the picker had something to point at. Every engine names a pasted screenshot `image.png`, so each paste is renamed `pasted-1.png`, `pasted-2.jpeg` as it is taken: two identical names would otherwise reach the agent as two attachments it cannot tell apart. The listener is on the document rather than on the textarea, because the composer is not focused after clicking a topic or a button and a paste that reaches nothing looks like a broken feature. A paste carrying no file is left alone, so pasting text into the composer still works the ordinary way.

- **Each topic in the web UI's sidebar says which directory it is working in.** A row carried only a title, so several topics open on different projects were told apart by remembering which was which. The row now has a second line with the project directory's name, and the full path on its tooltip — two checkouts of one project share a last segment. Deliberately not a copy kept beside the title: the daemon owns the answer and `/cd` moves it, so the adapter is handed a *lookup* (`PlatformAdapter.useWorkdirLookup`, optional and implemented only here — a chat platform has nowhere to put this) and asks per render, memoised for a few seconds because the list is rebuilt on every message. A directory changed with `/cd` is on the sidebar within seconds, and a topic that has never run still shows the root its agent would start in.

### Changed

- **Your own messages in the web UI now sit on a tinted panel instead of behind a hairline rule.** A 2px border and a 10px indent were all that separated the two sides of the conversation, and scanning back through a long transcript for where your own question ended and the answer began was harder than it should be. Own messages get a cool-tinted background; the agent's side stays flat on the page background. Only one side is marked deliberately — marking both would move the problem rather than solve it — and the quote rail and code blocks inside the panel are lifted a step so they do not disappear into the tint.

## [1.16.0] - 2026-09-19

### Changed

- **Agent questions (`ask`) wait up to 1 hour, post a 30-minute reminder notice, and reclaim the resident process upon timing out.**
  - The previous 10-minute timeout caused questions to close prematurely if the operator stepped away, while an indefinite wait would tie up hundreds of megabytes of resident agent memory indefinitely.
  - Clarifying questions now remain open for 1 hour by default (matching `session.idleTimeoutMs`). If unanswered after 30 minutes, an intermediate reminder notice is automatically posted to the channel.
  - When the 1-hour window expires without a response, buttons are retired, the question is marked timed out, and the resident agent child process is reclaimed cleanly. When the user eventually responds, the conversation is automatically rehydrated from stored session state (via ACP `session/load` or agy `--conversation`) and their answer is processed as normal.

- **Repository metadata and README links now point at this fork rather than at the repository it came from.**
  - `repository`, `homepage` and `bugs` in `package.json` still named the upstream repo, so `npm bugs` opened their tracker and the npm page linked to their code. The README badge rendered *their* CI status, and the `npx skills add` one-liner installed *their* skill rather than the one in this tree — the four references a reader is most likely to act on all pointed at a different project. All now point here.
  - Both READMEs credit the origin in their License section. `LICENSE` is unchanged and still carries the upstream copyright notice, which is what MIT asks for and what covers this tree too.

## [1.15.1] - 2026-09-19

### Fixed

- **The web UI showed an empty page while its event stream was working perfectly.**
  - Opening the UI at its own address — no `?t=` on the URL, which is how anyone reaches it the first time — rendered nothing at all: no messages, no topic list, no title. The stream was connected and the `sync` event was arriving; the browser was throwing it away.
  - The stale-sync guard added alongside the 1.15.0 message cache compared the event's topic against the client's own, but a first visit has no topic yet — the server is the one that picks it, precisely because the client named none. Comparing against the empty string discarded the only `sync` that visit was ever going to receive, and the page had no second chance to ask. The guard now only fires once the client is actually on a topic, so the server's choice is accepted and written into the URL for the reload after it.

### Changed

- **The web UI is usable on a phone held upright.**
  - It was laid out for a desktop and only conceded a narrow screen the sidebar's position. On a portrait handset the composer sat under the collapsing URL bar, tapping it zoomed the page in and left it there, the Send row hid behind the home indicator, and the topic drawer covered the chat with nothing but the one button it obscured to dismiss it.
  - Below 640px the sidebar is now a fixed drawer sized to the screen with a backdrop that closes it, viewport heights are stated in `dvh` so the composer stays where the browser chrome actually ends, the composer and token fields are 16px because Safari zooms in below that and never zooms back out, the Send row clears the home indicator via `env(safe-area-inset-bottom)`, and the input is no longer focused on open — the keyboard took half the screen before anything had been read.

## [1.15.0] - 2026-09-19

### Added

- **Topics in the web UI can be deleted directly from the sidebar.**
  - An inline delete button (`×`) appears on hover next to each topic in the sidebar. Clicking it prompts for confirmation, then removes the topic from persistent storage, cleans up the room's in-memory state, and broadcasts the updated topic list to all connected clients.
  - Deleting the currently active topic automatically navigates to the next available topic in the list, or mints a new one if none remain, ensuring the client is never stranded in an invalid room.
  - The HTTP server guards topic deletion with session authentication and CSRF origin verification, supporting both `POST /api/topics/delete` and `DELETE /api/topics`.

### Changed

- **Web UI scrollbars match the dark theme.**
  - Custom scrollbar styles (`scrollbar-color`, `scrollbar-width: thin`, and `::-webkit-scrollbar` with subtle dark thumb and transparent track) eliminate the jarring contrast between default bright system scrollbars and the pitch-black background across all browsers.
  - `color-scheme: dark` is declared on `:root` to ensure native system controls and browser-level overlays default to dark mode.

- **Topic switching is instant via client-side LRU message caching.**
  - Switching topics previously incurred a noticeable delay while the client tore down its event stream, initiated a new HTTP connection, and waited for the server's compressed `sync` event.
  - The browser now maintains a bounded LRU cache (capped at 10 recent topics and 40 messages each, synchronized to `sessionStorage`) of recent message history. When switching to a cached topic, its messages and status render in 0ms, followed by an immediate background stream reconnect that seamlessly reconciles any newer messages from the server.

## [1.14.0] - 2026-09-18

### Changed

- **The web UI switches to a collapsible left sidebar, distinguishes running from finished topics, and badges unread messages.**
  - Topic navigation moves from the top header bar to a dedicated left sidebar (`#sidebar`) displayed as a vertical list. The sidebar can be collapsed to maximize chat space using `◀` and re-opened via `☰` from the chat header, remembering the user's preference in `localStorage`.
  - Active turns are visually distinct from finished sessions: topics running an agent turn show a bright pulsing status indicator and highlighted title, while finished/idle topics show greyed-out titles and muted status dots.
  - Topic entries in the sidebar badge unread message counts in real-time. Background topics increment unread counts as messages arrive and clear as soon as the user selects the topic.


## [1.13.0] - 2026-09-18

### Added

- **The web UI has topics, and they work the way a Telegram forum topic does.** A row of names
  across the top switches between parallel conversations; each has its own agent session and its
  own context, and each names itself from what it turned out to be about. `+` opens one, the agent
  can open one for itself with `agent-anywhere create-thread`, and write into one with
  `--channel main/<topic id>`.

  A topic is a LANE on the one channel rather than a channel of its own, and the difference is the
  naming: `retitleLane` refuses any address with no lane, so `capabilities.renameThread` can only
  ever be true for a lane. A channel-per-topic design would have given the same conversation
  separation and left the automatic naming permanently inert.

  The `kind` stays `direct` even though a lane is set, which looks wrong and is not. `shouldRespond`
  answers a DM at step 3 and only reaches its mention requirement at step 6; a `kind: 'thread'`
  message that is not a DM, has no active session yet and carries no @ falls through to that step —
  and `chat.requireMention` defaults to true, so the FIRST message in every new topic would have
  been dropped without a word. A DM that has lanes is a shape the gateway already knows: a Telegram
  DM topic is exactly this.

  The topic list is persisted next to the daemon's own state, and that is not cosmetic: losing it
  would leave every one of those conversations still bound and still resumable in
  `conversations.json` under `<instance>#main#<topic id>`, and unreachable because nothing knew the
  ids any more.

  **Upgrading resets the web UI's existing conversation, once.** Its key was `<instance>#main#`
  with no lane; a topic makes it `<instance>#main#<id>`, so the old one is no longer looked up. It
  is one platform, one version old, and a migration shim for a shape published a day earlier costs
  more than starting the conversation again.

- **The web UI is usable on a weak, high-latency link.** Three changes, and together they took a
  thirty-second streamed answer from 13 updates and ~2.6 KB to 3 updates and ~600 bytes:

  Replies are announced when they settle rather than on every flush. Each streaming flush
  re-renders the whole message, so announcing all of them sent the same growing body over and over.
  The settle window is 1500ms *because* `EXPERIENCE.stream.flushIntervalMs` is 1200ms — anything
  below that expires between every pair of edits, announcing each one separately and saving
  nothing. Any non-edit event flushes what is held first, so a tool bubble's final state still
  arrives above the text that followed it.

  A dropped stream resumes. Every event now carries a sequence number as the SSE `id:` field and
  each topic keeps a backlog, so `EventSource`'s own reconnect is answered with the handful of
  events that were missed instead of the entire conversation — which is what every network blip
  used to cost.

  Everything on the wire is compressed, the event stream included. That one has a trap in it: a
  gzip stream buffers until told otherwise, so each event is followed by an explicit
  `Z_SYNC_FLUSH`; without it the page receives nothing until the connection closes, which reads
  exactly like a hung daemon. The test that pins it hangs rather than failing an assertion if the
  flush goes away.

  Sends carry a nonce, so the page can retry one that timed out without risking a double post. The
  daemon's own inbound dedup cannot cover this — it keys on a message id, and a retry mints a fresh
  one.

### Fixed

- **`agent-anywhere create-thread` tells you the thread it just made.** It never has, on any
  platform: the daemon returned the adapter's `{address}` verbatim while the CLI reads
  `data.threadId`, so the command printed an empty id and the help line under it read "send into
  this thread by passing `--channel`" with nothing after it. The daemon now answers in the shape
  the protocol declares, formatting the address the same way `--channel` parses it back — a bare
  channel where a thread is a channel of its own, `<channel>/<lane>` where it is a lane — so the
  help line is true wherever it is printed. Found while making that command do something real on
  the web UI, where it opens a topic.


## [1.12.0] - 2026-09-18

### Added

- **A built-in web UI, so the gateway is usable with no chat platform at all.** Every way into this
  daemon so far needed a bot registered somewhere first — an account, a token, a console, and in
  three cases a public callback URL. `type: webui` needs a port and a password. The daemon serves a
  plain dark chat page itself; you open it, type the token once, and get the same conversation every
  other platform gets: streaming in-place edits, tool bubbles, lifecycle reactions, the `/model`,
  `/cd` and `/setting` button menus, `ask` questions, and attachments in both directions.

  It is deliberately not a Satori adapter. `satori-core.ts` assembles a platform around a `Bot` —
  resolve one, call `bot.sendMessage`, normalise a `Session` — and here the daemon owns both ends of
  the conversation; forced through the profile seam, every method would be a stub around state the
  module holds anyway. So it implements `PlatformAdapter` directly and `platform-factory.ts`
  dispatches it before `PROFILES`, which is typed `Record<Exclude<PlatformType, 'webui'>, …>` so the
  next Satori platform still fails to compile until it is listed. The cost of leaving that seam is
  that everything `satori-core` did for free has to be done again — the `chat.channels` allowlist,
  the `[in]` log line, `measureRendered`, and typed outbound failures — and each is re-implemented
  with a comment naming it, because the failure mode of forgetting one is silence rather than an
  error. `src/platform/webui/README.md` lists all of them.

  The page is one conversation: no sidebar, no room list, no threads, `/new` to start over. Markdown
  is rendered server-side by a new converter alongside the other seven (`web-markdown.ts`), and that
  converter is the repo's only XSS boundary — what it renders is agent output, which carries the
  bytes of every file the agent read, so it escapes every character before building a tag and passes
  no raw HTML through, ever. Transport is server-sent events rather than a WebSocket: Node ships no
  WebSocket server, the browser ships `EventSource`, and the only thing given up is client→server
  streaming, which nothing wanted.

  Security, stated plainly because the defaults are deliberate. `host` is `0.0.0.0`, because a
  gateway for reaching your agent from elsewhere is not useful bound to loopback — which is safe
  only because `token` is mandatory. There is no TLS; put a reverse proxy in front before this
  crosses a network you do not control (and turn its response buffering off, or server-sent events
  arrive all at once at the end of the turn). The secret is compared with `timingSafeEqual` and
  rate-limited to five guesses a minute per source; sessions are `HttpOnly; SameSite=Strict` cookies
  held in memory. Files the agent sends are reachable only through an opaque token and always served
  `attachment` + `nosniff` as `application/octet-stream`, so an agent-sent `.html` can never render
  on this origin. Uploads become `data:` URLs — the shape `adapter-telegram` already produces, so
  they travel the attachment pipeline's existing branch and its SSRF guard has nothing to act on.
  `doctor` gained a check for the three ways this ends up configured but dead: a port already held,
  a non-loopback bind, and an `access.allowFrom` that does not list `<instance id>:owner` — the last
  of which otherwise presents as a page that accepts your messages and never answers one.

### Fixed

- **A conversation on a platform that cannot rename anything no longer pays for a title it will
  throw away.** `nameConversation` summarised a topic name with a model call and only then asked
  `retitleLane` whether the rename could happen — and `retitleLane` refuses both a platform without
  `capabilities.renameThread` and any address with no lane. So QQ, LINE, WeCom and DingTalk, which
  declare no rename at all, and every plain channel on the four platforms that do, spent one
  title-summarising call per new conversation on a string nothing ever read. The capability check now
  happens before the call rather than after it. `retitleLane` still re-checks both conditions itself,
  because `/title` owes the user a sentence naming which one fired, and the two answers send them
  looking in different places.


## [1.11.2] - 2026-09-17

### Fixed

- **Telegram images reach the agent.** Every inbound photo, document and voice note was dropped, and
  almost silently: the log carried one `TypeError: Invalid URL … input: '/photos/file_10.jpg'` and
  the agent simply received a message with no attachment. Two upstream packages disagree, each
  reasonable alone — `adapter-telegram` asks for a file by its API-relative path against an
  `endpoint` carrying the bot token, and `@satorijs/core`'s `http/file` listener runs `new URL()` on
  whatever it is handed. `plugin-http` emits that listener *before* it resolves the path, so satori
  sees `/photos/…`, throws, and the adapter turns the throw into an image element with no `src` at
  all. Not fixable by upgrading: those are the current releases of both (checked 2026-09-17).

  A listener prepended to the same event resolves relative paths first, so satori's own only ever
  sees the absolute URLs it was written for. It is pinned by a contract test that reproduces the
  upstream bug itself, so the day upstream guards that call, the test fails and this workaround can
  be deleted.

  Fixing that exposed the layer behind it. adapter-telegram does not return a link — it downloads the
  file with the bot token and inlines it as `data:<mime>;base64,…`, a shape the attachment pipeline
  had never actually been handed, because nothing had ever got that far. The downloader now returns
  such bytes directly (the SSRF guard has nothing to act on — no host, no DNS, no request — so only
  the size cap applies, and it is enforced), and the ingest names the file from its mime instead of
  the last `/`-separated chunk of the URL, which for one of these is a slice of base64. The failure
  lines quote a truncated form too: quoting a `data:` URL back would paste the entire image into the
  prompt as base64, through the error path, past every size limit meant to prevent exactly that.

## [1.11.1] - 2026-09-17

### Fixed

- **A rate-limited opencode no longer reads as a hung agent.** Reported 2026-09-17: every `oc` turn
  sat at "typing" for ten minutes and then failed with `agent "oc" sent no update for 600000ms;
  treating it as hung and aborting this turn`. The agent was not hung — opencode's free model pool
  was rate-limiting it and opencode was retrying internally, reporting that neither over ACP nor on
  its stderr (which the daemon already forwards; `grep -c "Rate limit" daemon.log` → 0). The only
  record on the machine was opencode's own log file, and the daemon's ACP session id appears in it
  verbatim, so one conversation's errors can be picked out of a log shared by all of them.

  A turn now asks that log. While it runs, each distinct reason is announced once as its own message
  (`⚠️ oc hit an error and is retrying: AI_APICallError: Rate limit exceeded…`), so a ten-minute wait
  explains itself in the first minute instead of at the end. If it does time out, the reason is
  appended to the failure message — read *before* the subprocess is reaped, since disposing it
  destroys the session id the lookup needs.

  Deliberately does not end the turn early: a logged error means something went wrong, not that the
  turn is lost, and opencode often retries and wins. Nothing is guessed either — a moved log, a
  renamed field or an unparsable line yields no reason and the message stays exactly what it was.
  Only opencode has a probe; claude rejects the prompt with its own reason already, and agy speaks
  no ACP. The seam (`daemon/harness-log.ts`) is per-harness so the next silent one is a table entry.

## [1.11.0] - 2026-09-17

### Added

- **agy gets its skills back, and they were never really the problem.** The harness was launched with
  `--disable-slash-commands` because a slash in a stream-json session can kill it — and that is true,
  but of eleven names, not of every `/`. Re-probed on agy 1.2.0: a skill slash expands and answers
  normally, an unrecognised one reaches the model as plain text, and only the commands agy's own CLI
  intercepts are fatal (`status:ERROR` and process exit 2, which takes the conversation's child and
  every turn queued behind it). Those eleven are exactly what `agy -p /help` lists, so the flag is
  gone and the names are kept out of the session by name instead. Typing `/some-skill do the thing`
  on agy now does what it does on claude.

  The same eleven are no longer refused either: each is answered by a one-shot `agy -p=/<name>` run
  in the conversation's directory, which is what agy's error message recommends. `/usage` therefore
  reports real quota — pools, percentages left, and when each resets — and `/credits`, `/effort`,
  `/config` and the rest answer in chat instead of "not supported". No model is invoked and no turn
  is spent: the CLI answers these from local state.

- **`/skills` finds agy's skills.** Five locations, which are agy's own rather than a guess:
  `<cwd>/.agents/skills`, `~/.agents/skills`, `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`
  and `~/.gemini/config/skills`. Asking agy instead was tried first and is not usable — `agy -p
  /skills` answers with six entries here and omits all 25 under `~/.agents/skills`, skills it
  nonetheless expands when they are typed.

- **The footer finally shows agy's context usage.** agy reports no token counts over its protocol,
  which is why `/context` on it answered "not supported" and the footer had nothing to print. It does
  publish them — to whatever `statusLine` command its settings name, in headless runs as well as the
  TUI (45 invocations across one measured two-turn session, the count climbing from zero to a real
  number). The daemon now installs a shim into that setting and reads the snapshot back at the end of
  each turn, so `used / size` reaches the same footer path the ACP harnesses use and `/context`
  answers like it does everywhere else.

  This writes to another product's config file, which nothing else here does, so: the previous
  settings are backed up once, every other key is preserved, the shim still draws a status line for
  the terminal (the same two lines this machine's operator had), and `AGENT_ANYWHERE_NO_AGY_STATUSLINE=1`
  turns the whole thing off. `doctor` reports whether the setting is wired, since that is the only
  explanation for an agy conversation with no numbers.

## [1.10.0] - 2026-09-14

### Fixed

- **Typing an answer no longer kills the question — or the ones after it.** When the agent asks with
  buttons and none of the options fit, the only usable answer is to type one. That message went to
  the inbound merger, whose job is to interrupt the running turn — and the running turn is the one
  blocked on the question. So on a form that asked three things, answering the second in words threw
  away the first two answers, never asked the third, and re-ran the reply as a fresh instruction
  stripped of the context that made it an answer. Reported from a real session; reproducible on every
  multi-question form.

  A message arriving while a question is on screen is now recorded as the answer to that question and
  consumed there, so the form carries on to the next one. The words travel back under the question's
  own free-text field — `question_<n>_custom`, which claude-agent-acp declares beside every question
  and prefers over the enum — rather than being passed off as an option the model listed; that
  distinction is why the parser now keeps a field it used to drop. Two messages deliberately keep
  their old meaning: one carrying an attachment (the field takes a string, so the image could only be
  dropped in silence), and one answering a question whose form declared no free-text field at all (an
  MCP server's own elicitation). Both interrupt, as before — which is also the way out of a question
  you cannot answer. `/stop`, `/new` and the daemon's other commands are still read as commands.

- **An answered question stops looking like an open one.** The bubble is now edited on every exit —
  tapped, typed, timed out, `/stop`, `/new`, or any interruption of the turn it belonged to — with
  the buttons cleared and the outcome written onto it. Two things were wrong before: the edit went
  through `editMessage`, which only drops components on Discord and Telegram, so on Slack and Lark
  the buttons of an already-answered question stayed clickable against a request that no longer
  existed; and a turn cancelled while blocked on a question left that question behind entirely,
  pinning the agent's child process for the rest of the ten-minute ask timeout.

## [1.9.1] - 2026-09-12

### Fixed

- **A turn reads in the order it happened again.** Tool bubbles are painted asynchronously so that a
  rate-limited chat cannot stall the reply behind a progress write — but the painter runs one write
  *behind* the turn's side-effect chain, so a tool's bubble could be posted below the body text of
  the segment that came after it. A transcript read "now let me check the profile" → "found it,
  three profiles declare it" → and only then the search that found them. Reproduced with no rate
  pressure at all: the normal case, not a congestion edge.

  The fix rests on a distinction that keeps it cheap: only a SEND takes a position in the chat, while
  an edit rewrites a message that already has one. So the body now waits for a bubble to be *placed*
  before sending its next message, and for nothing else — a late ✓ still lands late and unordered, as
  it always did. At most one wait per bubble, started when the tool is registered and therefore
  overlapping the tool's own run, and bounded at two seconds: past that the reply goes on and the
  bubble lands where it lands. Order is what gets given up under a paused chat, never the answer.

  The reason this survived a careful review of that file is worth recording: `tool-flood.test.ts`
  drives the whole stack but asserts on `[...sends, ...edits]` — a shape in which interleaving
  cannot be expressed. The new `render-order.test.ts` logs every write to one array in the order the
  platform saw it.

## [1.9.0] - 2026-09-12

### Changed

- **A menu page holds what the platform can carry, not what the tightest platform can.** Page size
  was one constant (6) shared by `/cd`, `/model` and `/setting`, and a shared constant has to be the
  smallest of the platforms' limits — LINE bundles at most 4 buttons per template, QQ 5 per row. So
  a ten-project workspace was two pages, and *choosing a directory* meant paging, every time, on the
  phone the command exists for. It is now a per-profile capability (`menuPageSize`): Discord,
  Telegram and Slack declare 12, which is one page for a typical workspace and still well inside
  Discord's 25-component message limit. A profile that declares nothing keeps the conservative 6,
  because the way a too-large page fails is the platform rejecting the whole message.

  The resolved size is frozen with the menu when it is posted. A click arrives later, and re-reading
  the size then would draw page boundaries the message on screen was never built with — `Next ▶`
  would skip or repeat entries.

  The `page 1/N` counter now appears only when there is more than one page, which the `/setting`
  menu has always done. On a menu that fits, it was a line of noise above the answer.

- **`/cd` leads with the projects you actually work in.** The list was alphabetical, which is the
  one ordering guaranteed to ignore what the user does: the two projects being worked on this week
  sat wherever the alphabet put them. Directories are now ranked by frecency — how often each has
  been chosen, with every past choice discounted by its age at a fortnight half-life. Neither
  simpler answer works: a visit counter never forgets, so last quarter's project outranks this
  morning's forever, and a plain "most recently used" lets one curious click displace the project
  someone has lived in all month.

  Kept in `<configDir>/workdir-usage.json`, two numbers per directory (exponential decay is
  memoryless, so a running total is a complete stand-in for an unbounded visit log). Separate from
  `conversations.json` because how often a directory is used is a fact about the machine, not about
  one topic — a brand-new conversation gets the benefit on its first menu. A use is counted only
  where a move actually happened, so re-picking the directory already in use (how the menu is
  dismissed) and tapping one that has since been deleted both score nothing. The agent's root keeps
  the first slot: it is the way out of a project rather than one of them. With no usage file the
  order is the scan's alphabetical one, exactly as before.

## [1.8.2] - 2026-09-11

### Fixed

- **`/skills` puts each skill on its own line.** It joined them with commas, which turns 26 names
  into a wall of text with nothing to scan down and no way to pick one out at a glance — unusable
  on the phone the command exists for. The justification given for it was compactness, and that was
  simply wrong: one-per-line only trades `, ` for `\n`, so the real list went from 709 characters to
  684. There was never anything to trade away.

## [1.8.1] - 2026-09-11

### Changed

- **`/skills` reads the skill directories instead of asking the agent.** 1.8.0 answered from
  `available_commands_update`, the list a harness pushes when it BUILDS a session. That list is
  authoritative and it is also missing exactly when someone wants it: the daemon holds it in
  memory, so every restart empties it and the first `/skills` after an update answers "has not
  reported any commands" until some conversation happens to run a turn. Observed within the hour
  on 1.8.0's own deploy, asked in a fresh Telegram topic — the update restarts the daemon, which
  is precisely when a user goes looking.

  Disk has neither problem: it is readable before any agent has started and it survives a restart.
  A skill is a directory containing `SKILL.md`, found under `~/.claude/skills` and the
  conversation's own `<cwd>/.claude/skills` for claude, and under whatever `skills` names in
  `opencode.json` for opencode. Entries are followed through symlinks, because 25 of the 26 here
  are links into a shared tree and an `lstat` check would find none of them.

  What it lists changed with the source, and for the better: the harness's own bundled commands
  are gone. 1.8.0 showed 58 entries for claude, of which only 26 were installed skills and the
  rest (`/compact`, `/deep-research`, …) ship with the product and are already reachable from the
  menu or the harness picker. "The skills I installed" is both what was asked for and the only
  thing disk can answer honestly.

  The cost, taken knowingly: this reads another tool's private layout, so a harness that moves its
  skills directory silently empties the catalogue. An empty answer therefore names the directories
  it searched, and a harness with no known location (agy, dsh) says that rather than implying the
  skills are missing.

## [1.8.0] - 2026-09-11

### Added

- **`/skills` lists the commands the current agent actually offers.** The platform menu is one
  fixed set derived from config, so a harness's own commands — skills above all — have never
  appeared in it, and the only way to see them was the bare agent command (`/cc`), which first
  wants a directory and only then shows a button menu. That left the 26 skills this machine shares
  between claude and opencode effectively undiscoverable from a phone.

  It answers with text, not buttons, and that is the design rather than a shortcut. claude reports
  65 commands here while Discord caps an interactive message at 25 buttons, so a picker is a paging
  UI, and paging through 66 entries to find a name is worse than reading a list. The deeper reason
  is that buttons cannot carry free text: a tapped one would have to park a pending selection on
  the conversation and wait for the next message to complete it, buying a state machine, an expiry
  policy, and a bug where an unrelated message arrives first and gets absorbed. None of it is
  needed — typing `/server-ops check the disk` already reaches the agent untouched, because a name
  outside the generic vocabulary passes straight through. Invocation was never the gap; discovery
  was.

  The list is everything the agent reported minus what the gateway menu already covers (58 of
  claude's 65 here, 1.2 kB — one message on every platform). It is deliberately not narrowed to
  "skills": ACP carries no marker for one, `available_commands_update` sends only
  `{name, description, input}`, and the skill directories cannot stand in for it either, since
  claude reads a tree of symlinks while opencode reads a different tree named in its own config and
  the two sets differ. A hand-kept blacklist of built-ins would rot on every harness release, so
  the catalogue says what it is instead of guessing.

  An agent that has reported nothing gets a reply naming both causes, because the daemon cannot
  tell them apart: no session has been built yet (the list arrives on session build, not at
  startup), or the harness reports none at all — agy speaks no ACP, and dsh sends no
  `available_commands_update`.

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
