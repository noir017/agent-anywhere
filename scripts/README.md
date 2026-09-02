# `scripts/` — development utilities

Ad-hoc Node scripts, not part of the published package (`package.json` `files` ships
only `dist` and `skill`). They are plain `.mjs` — no build step, run them directly.

## `stop.mjs` — kill every running instance

```bash
npm run stop
```

The daemon is long-lived, and it is easy to end up with **more than one** instance
running: a `dist` daemon left over from before a rebuild, plus a fresh `tsx watch` one.
Multiple instances share the same bot token and **race to handle each message**, which
produces baffling "sometimes new behavior, sometimes old" symptoms. If you are debugging
something that behaves inconsistently between messages, run this first.

It also sweeps up orphaned `claude-agent-acp` children a killed daemon may have left
behind.

The process matching is deliberately narrow, so it never hits your editor, your coding
agent, or unrelated node processes:

- `node .../dist/cli.js start` — daemon started from `dist`
- `tsx ... src/cli.ts start` — daemon started from source (`dev:watch`)
- `claude-agent-acp` — agent subprocesses

Keep it narrow. A broader pattern here would kill the agent you are working in.

## `probe.mjs` — Discord gateway probe

A diagnostic that connects to Discord with the token from
`~/.config/agent-anywhere/config.yaml` and prints what arrives: whether the gateway
connects, whether messages are received, and whether the configured intents are
sufficient. Useful when the bot is online but silent.

> Note: it reads the **v0** config shape (`cfg.platform.token`) and its comments are in
> Chinese, unlike the rest of the repo. It predates the v1 `platforms:` map. If you touch
> it, update it to read `cfg.platforms.<id>.token`.

## Adding a script

Development-only utilities belong here. Anything a *user* needs is a subcommand of the
CLI instead — see [`src/commands/README.md`](../src/commands/README.md). Document what
the script is for and what it deliberately does *not* match, as `stop.mjs` does.
