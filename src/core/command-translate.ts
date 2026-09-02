import type { AgentDef, Config } from '../config/schema.js';
import type { SlashCommandSpec } from '../types.js';

/**
 * Generic slash commands and their per-harness translation (pure functions).
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
 * behind a per-harness picker (see pickerCommandsFor).
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

interface GenericCommand {
  /** Menu description, phrased for the generic meaning rather than any one harness. */
  description: string;
  /**
   * Native name per harness. A MISSING key means that harness has no equivalent —
   * the command is rejected, never forwarded.
   */
  native: Partial<Record<Harness, string>>;
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
  },
  model: {
    description: 'Show or change the model',
    native: { claude: 'model' },
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

/** Outcome of translating one leading `/name` for a target harness. */
export type CommandTranslation =
  /** Not part of the generic vocabulary: forward untouched (power users can still type native names). */
  | { kind: 'passthrough' }
  /** Generic and supported: forward as this native name (may equal the generic one). */
  | { kind: 'translated'; native: string }
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
  return native ? { kind: 'translated', native } : { kind: 'unsupported' };
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
 * One picker command per configured harness (`/claude`, `/opencode`, …), deduped and
 * ordered stably. Invoking it in a session belonging to that harness offers the
 * agent's own harness-specific commands; elsewhere it reports that it does not apply.
 *
 * `custom` is skipped: its harness name carries no meaning to a reader, and the set
 * of commands a custom executable offers has no stable label to advertise.
 */
export function pickerCommandsFor(cfg: Pick<Config, 'agents'>): SlashCommandSpec[] {
  const harnesses = new Set<Harness>();
  for (const agent of cfg.agents) {
    if (agent.harness !== 'custom') harnesses.add(agent.harness);
  }
  return [...harnesses]
    .sort((a, b) => a.localeCompare(b))
    .map((h) => ({ name: h, description: `Commands specific to ${h}` }));
}

/** Whether `name` is a picker command for one of the configured harnesses. */
export function pickerHarnessFor(
  cfg: Pick<Config, 'agents'>,
  name: string
): Harness | undefined {
  const lower = name.toLowerCase();
  return cfg.agents.find((a) => a.harness !== 'custom' && a.harness === lower)?.harness;
}
