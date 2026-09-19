# Design: `/model` support for the AGY harness

> **Status**: draft  
> **Scope**: `agent-agy.ts`, `agent-factory.ts`, `command-translate.ts`, `agent-agy.test.ts`  
> **Blocked by**: nothing — `agy` already has every primitive this needs

## Problem

The AGY harness is the only non-`custom` runtime where `/model` answers "not supported".
ACP harnesses (claude, opencode) support runtime model switching via
`session/set_config_option`; `agy` speaks its own stream-json protocol, which has no
equivalent in-band message — the model is fixed at spawn by `--model=`.

Users currently have two paths:

1. `/setting model.agy <name>` — writes to config.yaml, takes effect next **session**
   (the daemon must dispose the child first).
2. Edit config.yaml by hand and restart.

Neither gives the instant, per-conversation, mid-chat experience `/model` provides on
ACP harnesses. Since this gateway exists to remove "reach the machine to edit YAML and
restart", the gap is worth closing.

## Key insight: respawn IS the switch

`agy` cannot change models mid-process. But it **can** resume a conversation on a
different model:

```
agy --model=gemini-3.8-flash-high --conversation=abc123
```

The daemon already does exactly this — on idle reclaim, on `/cd`, and on crash recovery.
The lifecycle:

1. `teardown('model switch')` — kill the child, settle any in-flight turn.
2. Next `runTurn` → `ensureStarted()` → spawns with the new `--model=` **and**
   `--conversation=<id>` → `agy` restores the full conversation history from its own
   local storage, now served by a different model.

Context survives because `agy` owns the history on its own disk; the daemon only
remembers *which* of its sessions belongs where (`ConversationStore`). The conversation
id was already recorded when `init` named it, so the respawn replays it automatically.

This is the same path `reclaimState() === 'resumable'` already certifies as safe, and
the one the daemon README describes as "Reclaim is the restart path, applied one
conversation at a time."

## Available models

`agy models` outputs a TSV list of every model the installed CLI can serve:

```
gemini-3.8-flash-high	Gemini 3.8 Flash (High)
gemini-3.8-flash-medium	Gemini 3.8 Flash (Medium)
claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking	Claude Opus 4.6 (Thinking)
...
```

This is the authoritative source for the `ModelSelector.options` list — it is what `agy`
itself would accept as `--model=`, with a human-readable display name beside it. Running
it takes ~200 ms on a warm machine and requires no child process to be alive, so it can
populate the selector without spawning a session.

## Design

### 1. Model list cache (factory-level)

`createAgyAgentFactory` acquires the model list **once** at construction. This is a
factory-level concern, not per-session: the same CLI binary serves all conversations, so
the list is shared.

```typescript
// agent-agy.ts — inside createAgyAgentFactory
let cachedModels: Array<{ value: string; name: string }> | undefined;

async function fetchModels(): Promise<Array<{ value: string; name: string }>> {
  if (cachedModels) return cachedModels;
  const { stdout } = await execFile(AGY_COMMAND, ['models']);
  cachedModels = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split('\t');
      return { value: value!, name: rest.join('\t') || value! };
    });
  return cachedModels;
}
```

**Refresh strategy**: none. The list changes only when `agy` is upgraded, which
restarts the daemon anyway. An operator who adds a model provider and wants it
reflected can restart the daemon or send `/new` — the same cost as today's `/setting`.

**Failure mode**: if `agy models` fails (not on PATH, auth expired), `cachedModels`
stays `undefined` and `modelSelector()` returns `undefined` — `/model` answers "no
selector" with the same text ACP sessions use when they have no live child. The turn
path is unaffected.

### 2. `modelSelector()` on the AGY session

```typescript
modelSelector(): ModelSelector | undefined {
  if (!cachedModels?.length) return undefined;
  return {
    current: lastSeenModel ?? def.model,
    options: cachedModels,
  };
},
```

`current` prefers `lastSeenModel` (what `agy` actually reported in `init.model`) over
`def.model` (what the config asked for), because the two can disagree — `def.model` is
an alias or a preference, `lastSeenModel` is the resolved model the session is running.

This is synchronous, non-spawning, and matches the contract in `agent.ts`:
"Deliberately non-spawning: the selector arrives with session/new, and starting an agent
child merely to populate a menu is a worse trade than telling the user to send a message
first." The AGY selector does not need the child because the list comes from `agy models`,
not from the child's protocol.

### 3. `setModel()` on the AGY session

```typescript
// Per-session model override, same role as `modelPreference` in agent-acp.ts.
let modelPreference: string | undefined;

async setModel(value: string): Promise<string> {
  // Record the choice so the next spawn uses it. NOT written to def.model, because
  // findAgent returns a shared reference into cfg.agents — mutating it would affect
  // every session using the same agent definition.
  modelPreference = value;
  // Kill the current child. The next runTurn → ensureStarted spawns a new one with
  // --model=<value> --conversation=<id>. Context survives via --conversation.
  teardown('model switch');
  return value;
},
```

`buildAgyArgs` reads `def.model` for the `--model=` flag. With a `modelPreference`
override, `ensureStarted` must prefer it:

```typescript
const model = modelPreference ?? def.model;
const args = buildAgyArgs(def, cwd, agentSessionId, model);
```

This requires a small signature change to `buildAgyArgs` — adding an optional `model`
parameter that overrides `def.model`:

```typescript
export function buildAgyArgs(
  def: AgentDef, cwd: string, conversationId?: string, model?: string
): string[] {
  const effectiveModel = model ?? def.model;
  return [
    ...
    ...(effectiveModel ? [`--model=${effectiveModel}`] : []),
    ...
  ];
}
```

**Why NOT mutate `def.model`?**

`findAgent(cfg, id)` returns a reference into `cfg.agents` (no clone). `def` in
`createAgySession` points at that same object. If two conversations share one agy
agent and one switches models, the other's next spawn would unexpectedly inherit the
change. ACP solves this with a per-session `modelPreference` variable; AGY does the
same.

**Why `teardown` instead of a gentler approach?**

There is no gentler approach. `agy`'s stream-json protocol has no model switch
message, and the child's Go runtime does not reload configuration. The teardown →
respawn path is the same one `/cd` already uses (and for the same structural reason:
the directory is also fixed at spawn). The child starts within 2–3 seconds; the
conversation context is not lost.

**Effect on in-flight turns**: `teardown` settles the pending turn as an abort,
which `runTurn` swallows when `aborting` is set. The model switch is not mid-turn —
`/model` is intercepted by the registry before any turn starts. The only scenario
where this kills a running turn is if the user queued a message AND a model switch
simultaneously, which the merger serializes anyway.

### 4. Register `/model` as local for `agy`

In `command-translate.ts`, the `model` generic command's `local` list gains `'agy'`:

```typescript
model: {
  description: 'Show or change the model',
  native: {},
  local: ['opencode', 'claude', 'agy'],  // ← add 'agy'
},
```

This is what makes `translateCommand('model', 'agy')` return `{ kind: 'local' }`
instead of `{ kind: 'unsupported' }`, and what lets `ConversationRegistry.route` hand
it to `applyModelCommand` instead of refusing.

No change to `HARNESS_COMMANDS.agy` or its `picker: false` — `agy` still has no
native command list, and a bare `/agy` still acks the binding rather than posting
an empty menu. The model menu is a daemon concern, not a harness command.

### 5. Pre-fetch models at factory construction

`createAgyAgentFactory` calls `fetchModels()` eagerly (fire-and-forget at factory
creation, not awaited). This runs `agy models` once in the background; by the time
a user types `/model`, the list is ready. A failure is logged and the list stays
empty — no crash, no degradation of the turn path.

```typescript
export function createAgyAgentFactory(
  cfg: Config, socketPath: string, store?: ConversationStore
): AgentFactory {
  const sessions = new Map<string, AgentSession>();
  // Fire-and-forget: populate the model list for /model menus.
  // Failure is non-fatal (modelSelector returns undefined, /model says "no selector").
  fetchModels().catch((e) =>
    console.warn(`[agy] could not fetch model list: ${e instanceof Error ? e.message : e}`)
  );
  return { ... };
}
```

## Files changed

| File | What changes | Why |
|---|---|---|
| [`agent-agy.ts`](file:///home/user/workspace/agent-anywhere/src/daemon/agent-agy.ts) | Add `fetchModels()`, `cachedModels`, implement `modelSelector()` and `setModel()` on the session | The session is the single place the daemon reads a model selector |
| [`command-translate.ts`](file:///home/user/workspace/agent-anywhere/src/core/command-translate.ts) | Add `'agy'` to `GENERIC_COMMANDS.model.local` | Without this, `/model` on an agy conversation returns "unsupported" instead of reaching the local handler |
| [`agent-agy.test.ts`](file:///home/user/workspace/agent-anywhere/src/daemon/agent-agy.test.ts) | Add tests for `modelSelector()`, `setModel()` (verifies teardown, def.model mutation, respawn with new model) | The existing suite covers protocol translation; model switching is a new path |
| [`daemon/README.md`](file:///home/user/workspace/agent-anywhere/src/daemon/README.md) | Update the "Models" paragraph in the `agent-agy.ts` section | The README currently says "no selector and no in-process switch"; after this, there IS a selector |
| [`core/README.md`](file:///home/user/workspace/agent-anywhere/src/core/README.md) | Update the `local` table to include agy for `/model` | The table currently lists only opencode and claude |
| [`CHANGELOG.md`](file:///home/user/workspace/agent-anywhere/CHANGELOG.md) | Entry under `## [Unreleased]` | User-visible change |

## What this does NOT add

### Token usage / context display

`agy`'s stream-json protocol does not emit `usage_update` or any token count. This is
a protocol limitation, not a missing feature on the gateway side. Without data from the
agent, the gateway cannot fabricate numbers — and guessed numbers are worse than none
(the footer currently omits the context segment entirely, which is the correct behavior
documented in `runtime-footer.ts`: "A harness that does not [report usage] renders no
context segment rather than a guessed number").

The `/context` command stays `{ kind: 'unsupported' }` for `agy`, matching the rule
in `command-translate.ts`: "An honest 'not supported' beats an answer that never
arrives."

A static `contextWindow` per agent is already supported in config:

```yaml
agents:
  - id: agy
    harness: agy
    model: gemini-3.8-flash-high
    contextWindow: 1000000
```

This shows `/ 1M` in the footer (window size, no used count). It is a config concern,
not a code change.

### Dynamic model list refresh

The model list from `agy models` is cached once per daemon lifecycle. A new model
added to agy's provider config is picked up on daemon restart — the same cost as
adding a new platform or agent. An explicit refresh command (`/model refresh`) could
be added later but is not worth the complexity now: the list is stable in practice,
and a restart is cheap.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `agy` rejects `--conversation=` with a new `--model=` | Context lost on switch | Tested empirically: `agy` accepts both flags together and resumes the conversation with the new model. If a future `agy` version rejects it, it warns on stderr and starts fresh — the same degradation the daemon already handles for stale conversation ids |
| `agy models` output format changes | Empty model list | Parsed defensively (split on tab, fallback to value-only). An empty list means `modelSelector()` returns `undefined` — same as today |
| Respawn takes too long | User waits 2–3 seconds after switching | This is the same cost as idle reclaim. The daemon already accepts it. The typing indicator runs during `ensureStarted`, so the chat is not silent |
| `modelPreference` survives across conversations | No — `modelPreference` is a `let` inside `createAgySession`, scoped to one session handle. `/new` disposes the session handle and the factory creates a new one, starting from the config's value. Two conversations using the same agent get independent `modelPreference` variables |
