import type { AgentDef, Config } from '../config/schema.js';
import type { SlashCommandSpec } from '../types.js';

/**
 * The registered slash vocabulary: daemon commands, agent commands, and the generic
 * commands with their per-harness translation (pure functions).
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * Native platform slash commands are GLOBAL (Telegram setMyCommands is per-bot,
 * Discord per-application/guild), while agents are PER-SESSION. Registering the
 * union of what every agent reports therefore produces a menu that cannot say who
 * owns an entry, and an entry invoked from the menu is routed like any other
 * message — i.e. to `routing.default`, not to the agent that offered it. With two
 * harnesses configured that misfires concretely: opencode's `customize-opencode`
 * was landing on the `claude` agent.
 *
 * So the registered set is instead a small, FIXED vocabulary that means the same
 * thing everywhere, translated per harness at invocation time. A harness with no
 * equivalent gets an explicit "not supported" reply rather than a prompt it will
 * misread. Harness-specific commands are not registered globally at all; they live
 * behind the bare form of that harness's agent command (see HARNESS_COMMANDS).
 *
 * ── Provenance of the table ───────────────────────────────────────────────────
 * `claude` and `opencode` were captured live over ACP (available_commands_update)
 * from the harness versions this daemon launches. `gemini` is best-effort and
 * UNVERIFIED — carried over from names the CLI documents, no install to probe.
 * `codex` is deliberately empty: its ACP adapter could not be probed, and inventing
 * a native name would send a command the agent may silently misinterpret, which is
 * strictly worse than telling the user it is unsupported.
 */

/** Harness kinds an agent can declare (mirrors AgentDefSchema.harness). */
export type Harness = AgentDef['harness'];

/**
 * Commands the DAEMON answers itself — intercepted in ConversationRegistry.route() and never
 * forwarded to an agent. Defined here rather than in daemon.ts so that registration
 * (buildRegisteredSpecs) and `/help` read one list instead of two that can drift.
 *
 * `/help` deliberately shadows the harness's own `/help` (claude has one): from a chat client the
 * gateway's vocabulary is the one the user cannot discover any other way, while the harness's own
 * help is still one tap away inside its agent-command menu (`/cc`).
 *
 * `/stop` and `/new` are two commands rather than one because they answer two different asks. Both
 * end the running turn; only `/new` also destroys the context. Before `/stop` existed, "make it
 * stop" cost the user their whole conversation, since the only other interrupt was
 * `inbound.interruptOnNewMessage` — which fires as a side effect of sending another message, not
 * because anybody asked for it.
 *
 * `/setting` is the only command in this list that writes to disk, and the only one whose effect
 * outlives the conversation it was typed in: it edits config.yaml (see core/settings.ts for what it
 * will and will not touch). Registered alongside the rest because the alternative — reaching the
 * machine to edit YAML and restarting, which stops every resident agent — is the cost this gateway
 * exists to remove.
 *
 * `/cd` is the one that costs the most when used, and it is here rather than in the generic
 * vocabulary because it is not a question for the harness at all: the directory is recorded against
 * the CONVERSATION and read at spawn, so every harness gets it, including the ones (agy) that
 * expose no commands of their own. Its effect on the agent is the same as `/new` — a session is
 * pinned to the directory it started in — which is why the menu it opens says so before the tap.
 */
export const DAEMON_COMMANDS: SlashCommandSpec[] = [
  { name: 'new', description: 'Start a fresh conversation (clears context)' },
  { name: 'clear', description: 'Alias of /new: start a fresh conversation' },
  { name: 'stop', description: 'Stop the current turn (keeps the conversation)' },
  { name: 'cd', description: 'Choose the working directory (starts a fresh session there)' },
  { name: 'setting', description: 'Change a saved setting (default agent, model, session)' },
  { name: 'help', description: 'List the commands this gateway understands' },
];

interface GenericCommand {
  /** Menu description, phrased for the generic meaning rather than any one harness. */
  description: string;
  /**
   * Native name per harness. A MISSING key means that harness has no equivalent — the command is
   * then answered locally when `local` is set, and rejected otherwise. Never forwarded blind.
   */
  native: Partial<Record<Harness, string>>;
  /**
   * Harnesses where the DAEMON answers this itself, having no native spelling to translate to.
   *
   * These are not translations: they are questions the gateway can answer from what it already
   * holds, so a harness that never implemented the command still gets a real reply instead of
   * "not supported". Both current cases come off the ACP session rather than a slash command —
   * live usage (`usage_update`) and the session's model selector (`session/set_config_option`) —
   * which is exactly why they had no native name to translate to.
   *
   * A native spelling still WINS where one exists — `/context` on claude reaches claude's own
   * `/context`, which knows more about claude than this gateway does. The fallback fills a hole;
   * it never covers a harness that solved the problem itself.
   *
   * `/model` on claude is the deliberate exception, and it is not a violation of that rule so much
   * as a finding about what claude's own answer is. Probed live against claude-agent-acp 0.58.1:
   * `model` is NOT among the commands the adapter advertises (getAvailableSlashCommands), and a
   * forwarded `/model` is therefore just a prompt — it spends a turn and prints
   * "Current model: Opus 4.8 (1M context) … Usage: /model <name>", i.e. text you then have to type
   * against. Meanwhile the same session exposes the selector as a config option that
   * `session/set_config_option` switches. So the gateway answers it: one tap, no turn. The cost is
   * that only the five options the protocol lists can be chosen — claude's own prose names more
   * aliases (`opusplan`, `best`, a full model id) — and those stay reachable through
   * `agents[].env.ANTHROPIC_MODEL`, which is where this deployment pins its model anyway.
   *
   * A LIST rather than a flag, and populated only from what was probed live, for the same reason
   * `native` is: `agy` speaks no ACP at all (it reports neither usage nor config options), so
   * claiming a local answer there would hand the user "no numbers yet — send a message first"
   * forever. An honest "not supported" beats an answer that never arrives.
   */
  local?: Harness[];
}

/**
 * The generic vocabulary. Deliberately small: a command earns a place here only if
 * it means the same thing on more than one harness, or is common enough that a
 * clear "unsupported" is more useful than nothing.
 */
const GENERIC_COMMANDS: Record<string, GenericCommand> = {
  compact: {
    description: 'Compact the conversation to free up context',
    native: { claude: 'compact', gemini: 'compress' },
  },
  context: {
    description: 'Show current context usage',
    native: { claude: 'context', gemini: 'stats' },
    // Probed live against opencode 1.18.18: a turn emits `usage_update {used, size, cost}` exactly
    // as claude's adapter does, so the numbers the footer already shows can answer this with no
    // harness command involved.
    //
    // CONDITIONAL, and the condition is not the harness: opencode sends the notification only for a
    // model whose context window it knows. Re-probed on 1.18.27 — `opencode/big-pickle` reports
    // `{used, size: 200000}`, while a model from a custom `provider` block with no `limit.context`
    // reports nothing at all (not a zero window — no notification), and adding `limit.context` to
    // that model makes it report. The local answer is still right for the harness; the empty case is
    // a model-config gap, which is why describeContext names the fix instead of saying "not yet".
    local: ['opencode'],
  },
  model: {
    description: 'Show or change the model',
    // No native spelling anywhere, on purpose — see the note on `local` above for why claude's own
    // `/model` is not one worth translating to.
    native: {},
    // Probed live on both: session/new reports a `model` select with the full model list, and
    // session/set_config_option switches it (the daemon already uses that path to enforce
    // `agents[].model`). So the gateway can both show and change it without a slash command —
    // and, where the platform allows, offer the list as a menu instead of a name to type.
    local: ['opencode', 'claude'],
  },
  usage: {
    description: 'Show token usage and limits',
    native: { claude: 'usage' },
  },
  doctor: {
    description: "Health-check this agent's own setup",
    native: { claude: 'doctor' },
  },
  mcp: {
    description: 'Manage MCP servers',
    native: { claude: 'mcp', gemini: 'mcp' },
  },
  init: {
    description: "Set up this project's agent instructions file",
    native: { claude: 'init', opencode: 'init' },
  },
  review: {
    description: 'Review the current changes',
    native: { claude: 'review', opencode: 'review' },
  },
};

/**
 * The agent command each harness answers to — the single source for what gets registered,
 * which spellings resolve, and whether a bare invocation can offer a command menu.
 *
 * ── Why short names ───────────────────────────────────────────────────────────
 * These are typed on a phone keyboard, in the middle of a conversation, many times a day.
 * `/opencode` was the harness enum value leaking into the UI; `/oc` is what operators
 * actually type. The full harness name stays in `aliases` so existing muscle memory (and
 * any `when.command: opencode` rule already in a config) keeps working — it is simply not
 * registered, so it costs no slot in the platform menu.
 *
 * ── Why `picker` is a separate flag ───────────────────────────────────────────
 * Registering a command and having a command list to show are different questions, and
 * `agy` is the case that proves it: it reports no command list at all and is launched with
 * `--disable-slash-commands` (a CLI-answered slash kills the session — see daemon/agent-agy.ts),
 * so a bare `/agy` could only ever answer "no command list yet". It still earns a registered
 * command, because switching a conversation to agy is the useful half. With one flag per
 * concern, a bare `/agy` acks the binding while a bare `/oc` opens opencode's own menu.
 *
 * `custom` is deliberately absent: the harness name carries no meaning to a reader, and a
 * user-supplied executable advertises no stable command set to name.
 */
interface HarnessCommand {
  /** Registered name — the short form the platform menu shows. */
  name: string;
  /** Additional spellings that resolve here. Accepted when typed, never registered. */
  aliases: string[];
  /** Whether a bare invocation can offer this harness's own reported commands. */
  picker: boolean;
}

const HARNESS_COMMANDS: Partial<Record<Harness, HarnessCommand>> = {
  claude: { name: 'cc', aliases: ['claude'], picker: true },
  opencode: { name: 'oc', aliases: ['opencode'], picker: true },
  codex: { name: 'cx', aliases: ['codex'], picker: true },
  gemini: { name: 'gm', aliases: ['gemini'], picker: true },
  agy: { name: 'agy', aliases: [], picker: false },
};

/** Reverse index (every accepted spelling → harness), built once. Names are already lowercase. */
const COMMAND_TO_HARNESS = new Map<string, Harness>(
  (Object.entries(HARNESS_COMMANDS) as Array<[Harness, HarnessCommand]>).flatMap(([harness, cmd]) =>
    [cmd.name, ...cmd.aliases].map((spelling) => [spelling, harness] as [string, Harness])
  )
);

/** The registered command name for a harness, or undefined when it has none (`custom`). */
export function harnessCommandName(harness: Harness | undefined): string | undefined {
  return harness ? HARNESS_COMMANDS[harness]?.name : undefined;
}

/** The harness a command name addresses, accepting the short form or the full harness name. */
export function harnessForCommand(name: string): Harness | undefined {
  return COMMAND_TO_HARNESS.get(name.toLowerCase());
}

/** Whether a bare `/<command>` for this harness can offer the agent's own command list. */
export function harnessHasPicker(harness: Harness | undefined): boolean {
  return harness ? (HARNESS_COMMANDS[harness]?.picker ?? false) : false;
}

/**
 * The agent a command name selects: the first configured agent of the harness it addresses.
 *
 * This is what makes a registered agent command work with no `routing.pipeline` entry at all —
 * previously `/oc` meant something only because an operator had written `when: { command: oc }`
 * by hand, so a freshly installed deployment registered a menu whose agent commands were inert
 * and were forwarded to the bound agent as the literal text "/oc".
 *
 * Deliberately keyed on HARNESS, not on agent id: the registered name comes from the harness
 * table, so resolving it through anything else could register one name and select another. An
 * operator who wants a different mapping (or a second agent of the same harness) writes a
 * pipeline rule, which outranks this — see routing.ts resolveAgent.
 */
export function agentForCommand(cfg: Pick<Config, 'agents'>, name: string): string | undefined {
  const harness = harnessForCommand(name);
  if (!harness) return undefined;
  return cfg.agents.find((a) => a.harness === harness)?.id;
}

/**
 * The harness an agent command names when this deployment configures NO agent for it — i.e. the
 * command is a real name in the vocabulary but has nothing to select here (`/agy` with no
 * `harness: agy` agent in config.yaml).
 *
 * Exists because the alternative is the failure this gateway is built to avoid: the name resolves
 * to nobody, so the message keeps its `/agy` prefix and is forwarded verbatim to whichever agent is
 * bound, which reads it as one of ITS own slash commands, finds nothing, and produces no output at
 * all. The user sees a turn that ran and said nothing, with no hint that the command was never
 * wired. Naming the missing agent costs one message and points straight at the config.
 *
 * Consulted only AFTER resolveAgent has declined the name, so both a `when.command` rule and a
 * configured harness outrank it — an operator can still point `/gm` at anything they like.
 */
export function unconfiguredHarnessCommand(
  cfg: Pick<Config, 'agents'>,
  name: string
): Harness | undefined {
  const harness = harnessForCommand(name);
  if (!harness) return undefined;
  return cfg.agents.some((a) => a.harness === harness) ? undefined : harness;
}

/** Outcome of translating one leading `/name` for a target harness. */
export type CommandTranslation =
  /** Not part of the generic vocabulary: forward untouched (power users can still type native names). */
  | { kind: 'passthrough' }
  /** Generic and supported: forward as this native name (may equal the generic one). */
  | { kind: 'translated'; native: string }
  /** Generic, no native spelling, but the daemon can answer it: handle locally, do not run a turn. */
  | { kind: 'local' }
  /** Generic but this harness has no equivalent: reject with a message, do not run a turn. */
  | { kind: 'unsupported' };

/**
 * Translate a leading command name for the harness that will receive it.
 *
 * `custom` always passes through: nothing is known about a user-supplied ACP
 * executable, so rejecting its commands would break a working setup on a guess.
 * That is also the pre-existing behavior for every harness, preserved here.
 */
export function translateCommand(name: string, harness: Harness | undefined): CommandTranslation {
  const entry = GENERIC_COMMANDS[name.toLowerCase()];
  if (!entry) return { kind: 'passthrough' };
  if (!harness || harness === 'custom') return { kind: 'passthrough' };
  const native = entry.native[harness];
  if (native) return { kind: 'translated', native };
  return entry.local?.includes(harness) ? { kind: 'local' } : { kind: 'unsupported' };
}

/** Whether a name belongs to the generic vocabulary (i.e. is subject to translation). */
export function isGenericCommand(name: string): boolean {
  return Object.hasOwn(GENERIC_COMMANDS, name.toLowerCase());
}

/** The generic commands as registrable slash specs, in a stable (alphabetical) order. */
export function genericCommandSpecs(): SlashCommandSpec[] {
  return Object.entries(GENERIC_COMMANDS)
    .map(([name, cmd]) => ({ name, description: cmd.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Native names this harness reaches through the generic vocabulary. Used to keep a
 * harness picker from repeating commands that already have a top-level entry.
 */
export function genericNativeNames(harness: Harness | undefined): Set<string> {
  const names = new Set<string>();
  if (!harness || harness === 'custom') return names;
  for (const cmd of Object.values(GENERIC_COMMANDS)) {
    const native = cmd.native[harness];
    if (native) names.add(native);
  }
  return names;
}

/**
 * One agent command per configured harness (`/cc`, `/oc`, `/agy`, …), deduped and ordered stably.
 *
 * `/<cmd> <prompt>` switches the conversation to that agent and asks it; the bare `/<cmd>` binds
 * and then offers the agent's own harness-specific commands, which are deliberately NOT registered
 * globally (see the file header for why a union menu could not attribute or route them).
 *
 * Ordered by the registered name so the menu is stable across restarts and config edits.
 */
export function agentCommandSpecs(cfg: Pick<Config, 'agents'>): SlashCommandSpec[] {
  const harnesses = new Set<Harness>();
  for (const agent of cfg.agents) {
    if (HARNESS_COMMANDS[agent.harness]) harnesses.add(agent.harness);
  }
  return [...harnesses]
    .map((harness) => ({ harness, cmd: HARNESS_COMMANDS[harness]! }))
    .sort((a, b) => a.cmd.name.localeCompare(b.cmd.name))
    .map(({ harness, cmd }) => ({
      name: cmd.name,
      // Names what the command DOES, since the short name no longer says it. One phrasing for
      // every agent command — `Switch to <harness>` — because a menu whose entries describe the
      // same action in two different sentences reads as two different features; the bare form is
      // then advertised only on a harness that actually has a list to show.
      description: cmd.picker
        ? `Switch to ${harness} — alone, lists its own commands`
        : `Switch to ${harness}`,
    }));
}

/**
 * The `/help` body: every command this deployment answers, grouped by who answers it.
 *
 * Built from the same tables that drive registration, so a command can never appear in the
 * platform menu without appearing here (the drift that makes a help text worse than none).
 *
 * `harness` is the one currently answering the conversation: the generic vocabulary is filtered
 * to what that harness can actually do, because listing `/compact` to an agy user who will be
 * told "not supported" the moment they tap it is the silent-degradation this project avoids.
 */
export function buildHelpText(
  cfg: Pick<Config, 'agents'>,
  current?: { agent: string; harness: Harness | undefined }
): string {
  const lines: string[] = [];

  lines.push('**This gateway**');
  for (const cmd of DAEMON_COMMANDS) lines.push(`\`/${cmd.name}\` — ${cmd.description}`);

  const agents = agentCommandSpecs(cfg);
  if (agents.length > 0) {
    lines.push('', '**Agents** — `/<cmd> <prompt>` asks it; alone, switches and lists its commands');
    // Named by harness rather than reusing the menu description, which repeats the line above:
    // the menu has no header to carry that explanation, this section does.
    for (const spec of agents) lines.push(`\`/${spec.name}\` — ${harnessForCommand(spec.name)}`);
  }

  // Generic names are translated to each harness's own spelling at invocation time, so what is
  // listed is what this harness will actually accept.
  const generic = genericCommandSpecs().filter(
    (spec) => translateCommand(spec.name, current?.harness).kind !== 'unsupported'
  );
  if (generic.length > 0) {
    lines.push('', '**Works on the current agent**');
    for (const spec of generic) lines.push(`\`/${spec.name}\` — ${spec.description}`);
  }

  if (current) {
    lines.push('', `Answering now: **${current.harness ?? current.agent}**`);
  }
  return lines.join('\n');
}

