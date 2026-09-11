/**
 * The `/skills` catalogue: the skills installed for an agent, rendered as text (pure functions).
 *
 * The data comes from disk (daemon/skills-scan.ts), not from what the agent reports over ACP —
 * that history is in the scanner's header, along with the coupling it costs.
 *
 * ── Why text and not buttons ──────────────────────────────────────────────────
 * A picker was the obvious design and it does not fit: 26 skills are installed here and Discord
 * caps an interactive message at 25 buttons, so a picker is a paging UI before it is anything else,
 * and paging to find a name is worse than reading a list.
 *
 * The deeper reason is that buttons cannot carry free text. A tapped button would have to park a
 * "pending skill" on the conversation and wait for the user's next message to complete it, which
 * buys a state machine, an expiry policy, and a class of bug where an unrelated message arrives
 * first and gets absorbed. None of that is needed: typing `/server-ops check the disk` ALREADY
 * reaches the agent, because a name outside the generic vocabulary passes through untouched (see
 * ConversationRegistry.route). Invocation was never the gap — discovery was, and a list answers it.
 */

/** One installed skill: the name a user types, and the directory it was found in. */
export interface CatalogEntry {
  name: string;
  dir: string;
}

/**
 * Render the catalogue for one agent.
 *
 * Names only, no descriptions. A skill's `description` frontmatter is written for a model deciding
 * whether to load it and runs to several lines — `server-ops` alone is over 300 characters — so
 * including them would blow past every platform's per-message limit on a list this size. Names are
 * what a reader needs in order to type the next message; the agent itself can explain any one.
 *
 * The example uses a real name from the list rather than a placeholder, because the one thing a
 * reader has to learn here is that the name takes a request after it.
 */
export function formatSkillCatalog(agentLabel: string, skills: readonly CatalogEntry[]): string {
  const names = skills.map((s) => `\`/${s.name}\``).join(', ');
  const example = skills[0]?.name;
  const lines = [
    `**${agentLabel}** has ${skills.length} skill${skills.length === 1 ? '' : 's'}:`,
    '',
    names,
  ];
  if (example) {
    lines.push('', `Type one with your request after it — e.g. \`/${example} <what you want>\`.`);
  }
  return lines.join('\n');
}

/**
 * What to say when nothing was found.
 *
 * Names the directories that were searched, which is the whole of the diagnosis: either the harness
 * installs no skills (agy, dsh — nothing has been found for either) or they live somewhere this
 * does not look, and only the operator can tell which. Saying "no skills" without saying where it
 * looked leaves them with nothing to check.
 *
 * An empty `dirs` means the harness has no known skills location at all, which is a different
 * sentence — there is no path to print and nothing for the operator to go and inspect.
 */
export function formatEmptyCatalog(agentLabel: string, dirs: readonly string[]): string {
  if (dirs.length === 0) {
    return `**${agentLabel}** has no skills directory this gateway knows how to read.`;
  }
  const where = dirs.map((d) => `\`${d}\``).join(', ');
  return (
    `**${agentLabel}** has no skills installed.\n\n` +
    `Looked in ${where} for directories containing a \`SKILL.md\`.`
  );
}
