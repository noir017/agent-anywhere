# AGENTS.md

Conventions for coding agents working in this repository. Read this first, then read
the README of whichever module you are about to change — the details live there, not
here.

`README.md` / `README.zh-CN.md` are the *user*-facing docs (install, configure, run).
This file and the module READMEs are the *contributor*-facing docs.

## What this project is

A gateway daemon that connects chat platforms (Discord, Telegram, Slack, Lark, QQ,
LINE, WeCom, DingTalk) to a local coding agent (Claude Code, Codex, OpenCode via ACP,
or Google's Antigravity CLI). A user messages the bot; the agent runs on the operator's
machine; its answer streams back into a single, live-edited message.

Node ≥ 20, TypeScript ESM (`"type": "module"`, `module: NodeNext`), strict mode with
`noUncheckedIndexedAccess`. Published to npm as `agent-anywhere-cli`.

## Module map

Each module owns a `README.md` describing its contract, invariants, and how to extend
it. Do not duplicate that content here.

| Module | Responsibility | Doc |
|---|---|---|
| `src/config/` | Config schema, loading, `${VAR}` expansion, v0→v1 migration | [README](src/config/README.md) |
| `src/core/` | Platform-agnostic pure logic: conversation identity, gating, merging, streaming, tool bubbles, footer, attachments, command vocabulary | [README](src/core/README.md) |
| `src/platform/` | Satori-based IM adapters: the profile seam, 8 platform profiles, per-dialect markdown renderers | [README](src/platform/README.md) |
| `src/daemon/` | The running system: routing, conversations, turn orchestration, agent runtimes (ACP + agy) | [README](src/daemon/README.md) |
| `src/ipc/` | Reverse-command protocol over a unix socket (agent → daemon → chat) | [README](src/ipc/README.md) |
| `src/commands/` | CLI entry points: `setup`, `doctor`, `start`, reverse commands | [README](src/commands/README.md) |
| `src/types.ts` | Domain data shapes shared across modules. Types only, no behavior. | — |
| `src/cli.ts` | Commander wiring. `start` is lazy-imported to keep `--help`/`doctor` fast. | — |
| `scripts/` | Dev utilities (`stop.mjs` kills stray daemons, `probe.mjs` Discord gateway probe) | [README](scripts/README.md) |
| `skill/` | The bundled agent skill teaching an agent to use the reverse CLI | [SKILL.md](skill/SKILL.md) |

## Layering

Dependencies point downward only. This is currently true and must stay true:

```
commands ──► daemon ──► platform ──► core ──► config
     └────────┴──────────┴─────────► ipc
```

Enforced facts, verifiable with grep:

- `core/` imports only `config/` (types) and `types.ts`. It never imports `platform/`,
  `daemon/`, or any Satori package. Core is pure: no clock, no `process.env`, no IO —
  all of those are injected. This is what makes it unit-testable without mocks of the
  IM stack.
- `platform/` imports `core/proxy.ts` only. Profiles never see the whole `Config`,
  only their own typed `platforms.<id>` entry.
- `config/schema.ts` imports `platform/config-schemas.ts` (the per-platform credential
  schemas). That file is deliberately kept free of Satori imports so config loading
  never drags in the adapter chain.
- `ipc/` imports nothing from other modules except `types.ts`.
- `daemon/` is the only module allowed to depend on everything.

If a change requires an upward import, the design is wrong — move the pure part down
instead, or inject it as a dependency.

## Conventions

**Comments explain *why*, not *what*.** This codebase has an unusually high comment
density, and it is deliberate: nearly every non-obvious decision carries a comment
naming the constraint that forced it (a platform quirk, a protocol limitation, an
upstream bug). Match that. A comment restating the code is noise; a comment recording
why the obvious approach does not work is the point. When you discover a constraint the
hard way, write it down where the next reader will trip over it.

**Cite evidence for external behavior.** When code depends on a platform's documented
subset or an undocumented library internal, say so with the source and date (see
`platform/dingtalk-markdown.ts`, `platform/profiles/slack.ts`). Undocumented internals
get an explicit Hyrum's Law warning and a contract test.

**Single sources of truth.** Several lists are deliberately defined once and consumed
in many places. Extend the source, never a copy:
- `ipc/commands.ts` `REVERSE_COMMANDS` → CLI registration, the agent-facing hint, docs.
- `core/command-translate.ts` `GENERIC_COMMANDS` → the registered slash menu + translation.
- `core/settings.ts` — the `/setting` table → the menu rows, the text list, value validation,
  the config path patched, and the ack sentence.
- `platform/config-schemas.ts` → validation, the setup wizard's prompts, doctor.
- `types.ts` domain types → mirrored zod enums with `satisfies` so drift fails to compile.

**Exhaustiveness over defaults.** Discriminated unions are switched exhaustively with a
`const _exhaustive: never` guard, so a new variant fails to compile rather than
silently falling through (see `daemon/daemon.ts` `handleReverse`).

**Degrade explicitly, never silently.** A missing platform capability either degrades
to the closest sensible behavior (no edit → chunked sends; no buttons in the renderer →
plain text) or throws a message written for the user. It never half-works. Truncation
and dropped items are logged, never silent.

**Best-effort side effects don't break turns.** Reactions, headers, receipts, and menu
edits are `void`-and-`catch`: a failure is logged and the turn continues.

## Testing

Vitest, colocated: `foo.ts` is tested by `foo.test.ts` in the same directory. ~630
tests across 43 files.

```bash
npm test              # vitest run
npm run test:coverage # + v8 coverage with thresholds
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (flat config)
npm run build         # tsc -p tsconfig.build.json → dist/
```

Coverage thresholds are enforced only where they earn their keep (`vitest.config.ts`):
`src/core/**` at 70%, `daemon/attachment-io.ts` and `ipc/protocol.ts` on the
security-critical guards. Pure-wiring entrypoints (`cli.ts`, `types.ts`) are excluded.

What is worth testing here: pure functions in `core/`, the parsers and renderers in
`platform/*-markdown.ts`, the security guards (`attachment-io.ts` SSRF checks,
`ipc/protocol.ts` validation, `conversation-token-registry.ts`), and routing/gating
decisions. What is not: Satori adapter plumbing and live network paths — there is no
integration harness, so those are verified by hand.

Lint rules are machine-enforced discipline, not suggestions: zero `any` in non-test
code, no unused vars (`_`-prefix to opt out), `complexity ≤ 18`,
`max-lines-per-function ≤ 140`. Stylistic rules `warn`, correctness rules `error`.

> On Windows, two tests in `src/config/load.test.ts` fail on path separators
> (they assert POSIX paths). Pre-existing and platform-specific — not something your
> change broke.

## Security invariants

Do not weaken these without saying so explicitly in the PR:

1. **Agents run with full tool access.** The daemon auto-approves every ACP
   `session/request_permission`. The only access gate is `access.allowFrom`; an empty
   allowlist means anyone who can message the bot can run commands on the operator's
   machine. `loadConfig` and `doctor` warn loudly about this; keep the warning.
2. **The IPC socket is the trust boundary.** Peer JSON is untrusted — it is validated
   with the zod schema in `ipc/protocol.ts` (`.strict()`, never `as IpcRequest`). The
   socket is created under umask `0o077` and chmod'd `0600`. Tokens are compared with
   `timingSafeEqual`.
3. **Inbound attachment URLs are user-controlled.** `daemon/attachment-io.ts` blocks
   SSRF: scheme check, loopback/internal/cloud-metadata rejection, and re-validation of
   *every* redirect hop (`redirect: 'manual'`). Size caps are enforced before download.
4. **Secrets never round-trip to disk.** `${VAR}` expansion happens once at load, after
   parse and before validation; `setup`/`saveConfig` operate on the raw unexpanded
   object. Proxy URLs are redacted before logging.

## Adding things

- **A platform** → `platform/config-schemas.ts` (schema) + `platform/profiles/<name>.ts`
  (profile) + one line in `platform-factory.ts`. No wizard or daemon change needed.
  See [src/platform/README.md](src/platform/README.md).
- **An agent harness** → an arm in `AgentDefSchema.harness` + `resolveHarness` in
  `daemon/agent-acp.ts` if it speaks ACP, or a sibling runtime implementing
  `AgentFactory` if it does not (as `agent-agy.ts` does).
  See [src/daemon/README.md](src/daemon/README.md).
- **A reverse command** → an arm in the `IpcAction` union + an entry in
  `REVERSE_COMMANDS`; CLI registration and the agent hint follow automatically, and a
  missing `handleReverse` arm fails to compile.
  See [src/ipc/README.md](src/ipc/README.md).
- **A config field** → `config/schema.ts`. But first ask whether it belongs in the
  frozen `EXPERIENCE` block instead: the user-facing surface is deliberately five
  sections, and tuning knobs nobody adjusts were removed on purpose.
  See [src/config/README.md](src/config/README.md).
- **A `/setting` entry** → the table in `core/settings.ts`, plus an arm in
  `applyToConfig` (`daemon/settings-store.ts`), which is exhaustive so the live-apply
  behavior cannot be left undecided. Only fields where a chat-side edit is *safe* belong
  there; the deliberate exclusions and their reasons are in the same file.
  See [src/core/README.md](src/core/README.md#settingsts).

## Git

- Branches: work lands on `dev`, PRs target `main`.
- Merges use `--no-ff` (a real merge commit), never fast-forward.
- Commits carry no AI attribution or generated-with trailers.
- User-visible changes get a `CHANGELOG.md` entry under `## [Unreleased]`
  (Keep a Changelog format). The entries are prose explaining the *why*, matching the
  comment style — see the existing ones before writing yours.
