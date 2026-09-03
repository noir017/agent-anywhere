# `src/ipc/` — reverse commands

The channel that lets a running agent act on the chat beyond streaming text: send a
file, react, reply, open a thread, read history, ask a button question.

A reverse command never touches the platform API. It connects **back** to the daemon over
a unix socket, and the daemon resolves "which conversation is this?" from the turn token
and executes on the right adapter.

```
agent (Bash)
  └─ agent-anywhere send-file ./report.pdf
        │  commands/reverse.ts  → builds an IpcAction
        │  ipc/client.ts        → connects, sends {token, action} as one JSON line
        ▼
    unix socket  (<configDir>/daemon.sock, umask 0o077 + chmod 0600)
        │
        ▼  ipc/server.ts  → parseIpcRequest (zod, strict)
    daemon.resolveChannel(token)  → token → session → activeChannel
    daemon.handleReverse(action, address)    → platform.sendFile(...)
        │
        ▼  {ok: true, data} back as one JSON line → CLI prints TOON to stdout
```

This module imports nothing from the project except `types.ts`.

## Files

| File | Role |
|---|---|
| `commands.ts` | `REVERSE_COMMANDS` — the single source of truth for the command catalog |
| `protocol.ts` | The `IpcAction` union + its zod validation schema |
| `server.ts` | Daemon-side socket server |
| `client.ts` | CLI-side client used by short-lived reverse-command processes |

## `REVERSE_COMMANDS` is the single source of truth

One spec array drives three places, so they cannot drift:

- `cli.ts` registers commander subcommands from it (usage string, options, `build`).
- `agent-common.ts` `buildReverseHint()` generates the per-turn `<system-reminder>` the
  agent sees, from each spec's `hint`.
- `daemon.ts` `handleReverse` dispatches, with an exhaustive `never` guard.

**Adding a reverse command is two edits**: one arm in the `IpcAction` union
(`protocol.ts`) and one entry in `REVERSE_COMMANDS`. CLI registration and the agent-facing
hint follow automatically, and a missing `handleReverse` arm **fails to compile**. Do not
add a command by hand-registering it in `cli.ts`.

The catalog: `send-message`, `reply`, `edit-message`, `send-file`, `react`, `delete`,
`fetch-messages`, `create-thread`, `ask`.

`CHANNEL_OPTION` (`-c, --channel <id>`) is appended to every command. Empty means "the
current conversation", which is the default an agent should almost always use — the
`--channel` override exists for pushing proactively somewhere else.

Its value is `<channel>` or `<channel>/<thread>`, so an agent can target one topic or
thread rather than only a channel root. `server.ts` parses it through `parseAddress`,
which **validates**: a malformed value fails at the boundary with the input named,
instead of reaching a platform API as a garbled id (Telegram answers those with an opaque
400 far from the cause).

## The trust boundary

**The peer is an arbitrary short-lived process and its JSON is untrusted.** The agent
subprocess is what connects, but nothing about the socket guarantees that.

So `server.ts` validates structure at runtime with `parseIpcRequest` before dispatch, and
never casts `as IpcRequest`. A malformed or missing field would otherwise carry
`undefined` all the way down to the platform call layer. The schema uses `.strict()` to
reject extra fields, narrowing the trusted input surface, and each arm maps one-to-one to
an `IpcAction` variant — kept aligned at compile time via `z.infer`.

Optional `channelId` is `z.string().min(1)` rather than plain optional: an empty string is
illegal, not a synonym for unset. It stays a *string* on the wire and is parsed into a
`ConversationAddress` at dispatch — the protocol keeps one textual form, the daemon works
in the domain type.

Other hardening in `server.ts`:

- The socket is created under `umask(0o077)` **before** `listen()`, then chmod'd `0600`.
  The umask is what actually closes the hole — the file is created at `listen()` time
  under the ambient umask, leaving a world-accessible window that a later chmod alone
  cannot prevent. The chmod stays as a fallback for umask residue.
- `MAX_LINE_BYTES` (1 MiB) caps a single request line.
- `IDLE_TIMEOUT_MS` (30 s) drops connections that hang without sending, avoiding fd
  leaks.
- Per-connection `error` handlers, so one bad connection cannot take down the server.

Token comparison happens in `SessionTokenRegistry` (`timingSafeEqual`, see
[`src/daemon/README.md`](../daemon/README.md)), not here — this module delegates both
token validation and channel resolution to the handler.

## Client timeouts

`client.ts` reads the token from `AGENT_ANYWHERE_TURN_TOKEN`, injected by the daemon when
it spawned the agent. A missing token returns a clear structured error rather than
hanging: reverse commands are only meaningful inside a daemon-driven turn.

Timeout precedence is deliberate:

- `AGENT_ANYWHERE_IPC_TIMEOUT_MS` accepts only finite positive numbers. A bad value
  (`NaN`, negative, non-numeric) is **warned about and ignored**, not silently swallowed
  into `undefined` — otherwise a valid `0` and a garbage `NaN` are indistinguishable and
  an operator's misconfiguration gets no feedback.
- Blocking commands pass an explicit larger `timeoutMs`; the effective value is
  `max(env, explicit)`, so a small operator-set env cannot truncate a long wait and make
  the client give up before the daemon does. `ask` relies on this.
- Otherwise: env, or a 10 s default.

## Capability gating in the handler

`daemon.ts` `handleReverse` decides per action how to handle a platform that lacks the
capability. The three outcomes are chosen per action, not uniformly:

- **Degrade** — `reply` on a platform without native replies becomes a plain send. The
  message still reaches the channel with the closest available semantics.
- **Throw a written message** — `edit-message` and `create-thread`. Editing cannot be
  degraded to a fresh send (different message, wrong semantics), so the user gets
  `unsupported operation: …` instead of a low-level adapter stack.
- **Throw rather than return empty** — `ask` on a platform without buttons. Returning
  `{ chosen: null }` would look like "the user declined" and mask the real problem.

If you add an action, pick one of these three and say why in a comment.

## Output format

Reverse commands print **TOON** (`@toon-format/toon`) to **stdout**, never stderr —
stdout is the agent's only data channel. `cli.ts` reroutes commander's usage and
validation errors to stdout for the same reason, and the top-level catch emits
`{ error }` structured rather than throwing a stack.

`fetch-messages` truncates each row's content at 500 chars with a `…` marker, keeping a
history dump token-bounded.

## Tests

`protocol.test.ts` — the validation schema, with an enforced coverage threshold
(`vitest.config.ts`) because it is the trust boundary. `server.ts` and `client.ts` are
exercised indirectly through the daemon tests; the socket paths themselves have no
integration harness.
