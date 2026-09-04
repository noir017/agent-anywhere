# `src/platform/` — IM platform adapters

Everything platform-specific is funneled through one seam so that eight chat platforms
reuse one generic core. Adding a platform means writing **one profile file and one
schema** — no changes to `core/`, `daemon/`, the setup wizard, or `doctor`.

## Architecture

```
      daemon  ──uses──►  PlatformAdapter        (adapter.ts — capability interface)
                              ▲
                              │ assembled by
                     satori-core.ts             (generic: lifecycle, inbound
                              │                  normalization, send/edit/delete,
                              │                  reactions, history)
                              │ delegates platform specifics to
                     PlatformProfile            (profile.ts — the seam)
                              ▲
        ┌──────────┬──────────┼──────────┬──────────┐
     discord   telegram     slack      lark    qq/line/wecom/dingtalk
                                (profiles/*.ts)
```

Three rules keep this from rotting:

1. **`satori-core.ts` never imports a concrete platform.** It depends only on
   `PlatformProfile`.
2. **Profiles never see the whole `Config`** — only their own typed `platforms.<id>`
   entry. `platform-factory.ts` guarantees the entry's `type` selected the profile, so
   profiles read credentials without narrowing.
3. **Satori-generic Bot methods are called directly by core**, not through the profile:
   `sendMessage`, `editMessage`, `deleteMessage`, `createReaction`, `deleteReaction`,
   `getMessageList` are consistent across adapters (verified against the Koishi message
   API). Only genuine differences go through the profile.

## Files

| File | Role |
|---|---|
| `adapter.ts` | `PlatformAdapter` + `PlatformCapabilities` — what `daemon/` sees |
| `profile.ts` | `PlatformProfile` — the seam every platform implements |
| `satori-core.ts` | Generic assembly of an adapter from a profile + one instance |
| `platform-factory.ts` | `type` → profile factory dispatch |
| `config-schemas.ts` | Per-platform credential schemas (+ `ChatGateSchema`) |
| `profile-helpers.ts` | Shared pure utilities for profiles |
| `profiles/*.ts` | The eight platform profiles |
| `*-markdown.ts`, `markdown-tables.ts` | Per-dialect outbound markdown renderers |

`config-schemas.ts` is kept as a sibling module rather than inside each profile so that
**config loading never imports the heavy Satori adapter chain**. Keep it that way —
`config/schema.ts` imports this file.

## Capabilities, not platforms

`daemon/` and `core/` never branch on platform identity; they branch on
`PlatformCapabilities`. Current matrix:

| | Discord | Telegram | Slack | Lark | QQ | LINE | WeCom | DingTalk |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `editMessage` | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| `reaction` | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `typing` | ✓ | ✓ | – | – | – | ✓ | – | – |
| `reply` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| `thread` | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| `buttons` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| `editButtons` | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| `slashCommands` | ✓ | ✓ | ✓ | – | – | – | – | – |
| `maxMessageLength` | 2000 | 4096 | 3000 | 10000 | 1000 | 5000 | 2000 | 3500 |

**`editButtons` is not `editMessage && buttons`.** It is its own field because the
conjunction is right by accident and wrong in mechanism. Lark has both, yet its
`editMessage` posts `msg_type:'post'` through `im.message.update`, which cannot touch a
card — buttons live on a card and are replaced through `im.message.patch`. QQ and LINE
have buttons and no edit endpoint at all (LINE has no delete either, so not even
delete-and-repost is available). A caller that needs to advance a posted menu — the
paginated `/model` picker — checks this field and degrades to a text answer otherwise.

Three capability fields are easy to conflate:

- **`slashCommands`** means "can *receive* slash commands".
- **`canRegisterSlashAtRuntime`** (default true) means "can *register* them at
  runtime". Slack is explicitly `false` — its slash commands are registered
  out-of-band via the App config panel or manifest, so `registerCommands` is a runtime
  no-op and the daemon skips the pointless call (logging it once).
- **`slashNeedsAck`** means the platform requires an answer to close out the
  interaction. Discord does (its adapter auto-emits a DEFERRED response and the UI reads
  "the application did not respond" until a followup lands). Telegram-style platforms
  deliver slash as an ordinary message with nothing to close, where a receipt is pure
  noise.

`maxSlashCommands` caps a registration batch; the excess is registered as nothing but
**logged**, and still invokable by typing.

## `resolveConversation` — the one place a platform describes its thread model

Some platforms need more than a channel id to address a message. A Telegram forum topic
and a Slack thread are a `(channel, lane)` **pair**: the lane is a separate wire
parameter (`message_thread_id`, `thread_ts`), not part of the channel id. A Discord
thread is not — it has its own snowflake and every API call targets it directly.

One method covers all three:

```ts
resolveConversation(session): { channel, thread?, space?, kind }
```

- `channel` **must** be a complete API target on its own. Telegram's adapter reports a
  group topic's `channel.id` as the bare `message_thread_id` and puts the chat in
  `guild.id`, so the profile has to swap them back — echoing `channel.id` would address a
  nonexistent chat.
- `thread` is set **only** when addressing needs an extra wire parameter. A Discord
  thread is `kind: 'thread'` with **no** `thread`.
- `kind` is the sole thread/DM witness for routing and gating.

Lark is the fourth: a Feishu topic (话题) is `(chat_id, thread_id)`. The adapter reports
neither half as a lane — `channel.id` and `guild.id` are both the chat id — so the profile
recovers `thread_id` from the referrer the adapter picks off the event (`larkThreadIdOf`).

It replaced four methods (`isDirect`, `isThread`, `inboundChannelId`, `decodeChannelKey`)
that were derived independently from the same session and could therefore disagree — a
message routed as a thread but replied to as a plain channel, or the reverse. Telegram
needed a dedicated test just to police the agreement, and Slack failed it silently
(`isThread` hardcoded `false` while its outbound side emitted thread addresses). One
method cannot contradict itself.

`satori-core` calls it on **every** inbound path — message, button click, slash command —
so a profile cannot wire it for messages and forget the interactions. That omission is
why buttons clicked inside a Telegram topic used to resolve to the chat root, leaving a
blocking `ask` unmatched until it timed out.

### Addressing, outbound

Every outbound method takes a `ConversationAddress` (`{ channel, thread? }`), never a
string. The lane used to be smuggled through as `"<chat>:<topic>"` inside the channel id —
built in 5 places, decoded in 17, validated in none — and every path that forgot to decode
sent to the wrong place. Worse, Telegram truncates a malformed `chat_id` **leniently** in
private chats: `ok=true`, message in the chat root, nothing logged.

A profile that reports a `thread` must implement the overrides that can carry it
(`sendMessage`, `sendFile`, `typing`, …). If it doesn't, `satori-core`'s generic path
**throws** rather than silently posting to the channel root — see the guard in
`assertNoLane`.

Telegram and Slack put the lane on the wire as a parameter (`message_thread_id`,
`thread_ts`). **Lark cannot**: `im/v1/messages` has no `receive_id_type` for a topic, so the
only documented way in is `im.message.reply(<a message in the topic>, { reply_in_thread })`.
Its profile therefore keeps a `thread_id → message id` cache (`LarkTopicRouter`), fed by every
inbound topic message and every send it makes, and falls back to the thread history API on a
cold miss. A platform whose lane needs a *lookup* rather than a parameter should copy that
shape rather than reach for an undocumented endpoint.

## Markdown: one converter per dialect

Agents emit standard CommonMark. Almost no IM platform renders it. Each converter
documents its target dialect's supported subset **with the doc source and a verification
date** — keep doing that.

| Converter | Output | Notes |
|---|---|---|
| `discord-markdown.ts` | raw markdown | Discord renders CommonMark natively; **only** GFM tables are rewritten to bullets. Everything else passes byte-for-byte. |
| `telegram-markdown.ts` | Satori `h()` tree | The adapter serializes + escapes it (`parse_mode=html`). Hand-rolling Telegram-HTML is an escaping minefield and a malformed one is a 400. |
| `slack-markdown.ts` | mrkdwn string | Different dialect: `*bold*` single-asterisk, `<url|text>` links, no headings, no tables. Bypasses the adapter's `escape()`, so this file owns escaping. |
| `lark-markdown.ts` | Lark md string | Preserves `\n` (Lark's `md` segment treats them as breaks). No tables, headings, or blockquotes. |
| `dingtalk-markdown.ts` | DingTalk md string | A single `\n` is **not** a line break — lines are regrouped into blocks joined by `\n\n`. |
| `plaintext-markdown.ts` | plain text | LINE, QQ, WeCom render nothing; markers are stripped and structure flattened into readable lines. |
| `markdown-tables.ts` | shared | The table→bullets degrade shared by the string-emitting converters. |

**Stream safety is mandatory.** Every converter runs on *every* streaming edit, not just
the final flush. A half-received `**bold` (no closing `**`) must degrade to literal
characters, never to a dangling open marker or an unbalanced tag. The inline parsers
only rewrite a construct once they see its **closing** delimiter; unclosed input
accumulates as escaped literal text. Code fences are tracked so a table-looking line
inside a ``` block is never rewritten, and a GFM table is only rewritten once **both**
its header and its `|---|` separator have arrived.

Send and edit must run the identical converter, or the message flickers between two
renderings between edits.

## `profile-helpers.ts`

Collapses only **identical** decisions across profiles: outbound id extraction,
attachment meta extraction, the thread-less `resolveConversation` shape
(`plainConversation`, shared by lark/qq/line/wecom/dingtalk), button message fragments,
Satori button-interaction mounting, and the CJS-default-import unwrap
(`resolveDefaultPlugin`) that all seven adapters need.

Where platform SDKs genuinely differ — whether a reply carries a quote, `ts` validation
on thread creation — each profile keeps its own. Prefer reusing a helper before
hand-writing, but do not force two different decisions into one helper.

`installHttpService` matters more than it looks: most adapters declare
`static inject = ['http']`, and without the http service provided first, cordis
**silently suspends the plugin** and never instantiates the bot — no bot, no error.

## ⚠️ Slack depends on undocumented internals

`@satorijs/adapter-slack` and `@satorijs/core` are pinned to **exact** versions in
`package.json` (2.5.0 and 4.6.0). This is not caution, it is a load-bearing constraint:

`adapter-slack`'s Socket Mode `WsClient.accept()` handles only `hello` and `events_api`
frames and **completely ignores** `interactive` (block_actions) and `slash_commands` —
neither dispatching nor ACKing them. The adapter exposes no interaction events at all.
So the Slack profile wraps `bot.adapter.accept`, appends its own socket `message`
listener after each open/reconnect, and parses and ACKs those frames itself. It also
reads the underlying socket from two spots that are implementation detail, not API:
`WsClientBase.start()` assigning `this.socket` before calling `accept()`, and the
`WsClient` constructor setting `bot.adapter = this`.

Any minor upgrade may change this **without error**, silently dropping button and slash
reception. Mitigation: frame parse/normalize is extracted into the pure functions
`parseSlackInteractiveFrame` / `parseSlackSlashFrame`, pinned by
`profiles/slack.contract.test.ts`. **Before upgrading either package you must manually
regress Slack button and slash reception — no CI covers the live path.** Interaction
receiving works only in Socket Mode (`protocol: ws`); under `http` the adapter mounts
only the events endpoint.

## Adding a platform

1. Add a schema to `config-schemas.ts` and one arm to the discriminated union.
   Required fields (not wrapped in `optional`/`default`) become **the setup wizard's
   prompts automatically**, using each field's `.describe()` as the label — that is why
   adding a platform needs no wizard change.
2. Write `profiles/<name>.ts` implementing `PlatformProfile`. Declare capabilities
   honestly: an unimplemented optional method means the platform does not support it,
   and core degrades or throws clearly based on the declaration. Overstating a
   capability produces low-level adapter errors in the user's chat.
3. Add one line to `PROFILES` in `platform-factory.ts`.
4. Pick a markdown strategy: reuse `plaintext-markdown.ts` if the platform renders
   nothing; otherwise write a converter documenting the dialect's subset with sources.
5. If the platform's message limit counts something other than characters (UTF-8 bytes,
   post-render length), implement `measureRendered` — otherwise chunks overflow after
   rendering.
6. For button events, follow the decision table in `profile.ts`'s `mountButtonEvents`
   doc, top-down: use `mountSatoriButtonInteraction` if the adapter exposes the generic
   `interaction/button` event; only if it does not, hand-write a socket/internal hook —
   and document the internal behavior you depend on, as Slack does.

Then add a `profiles/<name>.test.ts`. Every existing profile has one; nine of the
module's sixteen test files are profile tests.
