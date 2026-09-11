import type { AgentCommand } from '../types.js';

/**
 * The `/skills` catalogue: the commands an agent offers, rendered as text (pure functions).
 *
 * ── Why text and not buttons ──────────────────────────────────────────────────
 * A picker was the obvious design and it does not fit: claude reports 65 commands here and
 * opencode 29, while Discord caps an interactive message at 25 buttons — so a picker is a paging
 * UI, and paging through 66 entries to find one name is worse than reading a list.
 *
 * The deeper reason is that buttons cannot carry free text. A tapped button would have to park a
 * "pending skill" on the conversation and wait for the user's next message to complete it, which
 * buys a state machine, an expiry policy, and a class of bug where an unrelated message arrives
 * first and gets prefixed. None of that is needed: typing `/server-ops check the disk` ALREADY
 * reaches the agent, because a name outside the generic vocabulary passes through untouched (see
 * ConversationRegistry.route). Invocation was never the gap — discovery was, and a list answers it.
 *
 * ── Why the catalogue is not filtered down to "skills" ────────────────────────
 * ACP carries no marker for one. claude-agent-acp's getAvailableSlashCommands emits exactly
 * `{name, description, input}` per command (verified against dist/acp-agent.js, 2026-09-11), so a
 * skill and a built-in are indistinguishable on the wire. Reading the skill directories instead
 * does not work either: on this machine `~/.claude/skills` is symlinks into one tree while
 * opencode reads a different tree named in its own config, and the two sets differ. So the
 * catalogue is honest about what it is — everything the agent reported, minus what the gateway's
 * own menu already covers — rather than guessing at a subset with a hand-kept blacklist of
 * built-ins that would rot on every harness release.
 */

/**
 * The commands worth listing: what the agent reported, minus anything the gateway's menu already
 * offers, in the order the agent reported them.
 *
 * `alreadyInMenu` is the set of native names reachable through the registered vocabulary for this
 * harness (genericNativeNames). Dropping them is the same trade the harness picker makes: a second
 * way to reach `/model` is noise, and worse, it is noise that implies the two spellings differ.
 *
 * Reported order is preserved deliberately. It is not alphabetical — claude lists skills first and
 * built-ins last — and that grouping is more useful to a reader than sorting would be, since the
 * entries someone wrote themselves land at the top.
 */
export function selectCatalogCommands(
  cmds: readonly AgentCommand[],
  alreadyInMenu: ReadonlySet<string>
): AgentCommand[] {
  const seen = new Set<string>();
  return cmds.filter((c) => {
    const name = c.name.toLowerCase();
    // A harness may report the same name twice (claude does, for a skill shadowing a built-in);
    // listing it twice would read as two different things.
    if (alreadyInMenu.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/**
 * Render the catalogue for one agent.
 *
 * Names only, comma-separated. Descriptions would be the obvious addition and they do not fit:
 * ~59 entries with prose run past 4 kB, which is over Discord's per-message limit and near
 * Telegram's, so including them would mean either truncating the list (hiding the very thing the
 * command exists to show) or splitting it across messages for every invocation. Names are what a
 * reader needs to type next; the agent itself can explain any one of them.
 *
 * The example line uses a real name from the list rather than a placeholder, because the one thing
 * a reader has to learn here is that the name takes a request after it.
 */
export function formatSkillCatalog(agentLabel: string, cmds: readonly AgentCommand[]): string {
  const names = cmds.map((c) => `\`/${c.name}\``).join(', ');
  const example = cmds[0]?.name;
  const lines = [`**${agentLabel}** offers ${cmds.length} command${cmds.length === 1 ? '' : 's'}:`, '', names];
  if (example) {
    lines.push('', `Type one with your request after it — e.g. \`/${example} <what you want>\`.`);
  }
  return lines.join('\n');
}

/**
 * What to say when the agent has reported nothing.
 *
 * Two genuinely different causes, and conflating them sends the user to the wrong fix:
 *  - no session has existed yet, so the list simply has not arrived (a harness reports it on
 *    session build, not on startup) — the fix is to send a message first;
 *  - the harness reports no commands at all, ever (agy speaks no ACP; dsh answers ACP but sends no
 *    available_commands_update) — the fix is to use a different agent, and no amount of waiting
 *    helps.
 *
 * The daemon cannot always tell which it is, so the text names both rather than asserting one.
 * Spawning an agent subprocess to find out is the trade this deliberately does not make — the same
 * call the harness picker makes.
 */
export function formatEmptyCatalog(agentLabel: string): string {
  return (
    `**${agentLabel}** has not reported any commands.\n\n` +
    `Either it has not started a session in this conversation yet — send it a message, then ` +
    `/skills again — or this harness reports none at all (agy and dsh do not).`
  );
}
