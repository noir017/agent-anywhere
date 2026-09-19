/**
 * Platform-agnostic runtime footer (pure functions). Renders e.g.
 * `cc · 18k / 1M (2%) · claude-opus-4-5`, joined by ` · `; empty string when no
 * field is available.
 *
 * Pure: no side effects, no clock, no process.env — home dir is passed in.
 */

/**
 * Displayable footer fields.
 * - `agent`   = the agent id from config (`cc` / `oc`), i.e. WHICH agent answered.
 * - `model`   = short model name.
 * - `context` = `18k / 1M (2%)`, tokens in context over the window size.
 * - `contextPct` = just `2%`, for a terser line.
 * - `cwd`     = working dir.
 */
export type FooterField = 'agent' | 'model' | 'context' | 'contextPct' | 'cwd';

export interface FooterInput {
  /** Agent id as configured (`agents[].id`), e.g. `cc` / `oc`. */
  agent?: string;
  /** Full model name (may carry a vendor prefix, e.g. `anthropic/claude-opus-4-8`). */
  model?: string;
  /** Context tokens used. */
  contextTokens?: number;
  /** Context window size, for the percentage. */
  contextLength?: number;
  /** Absolute current working directory. */
  cwd?: string;
  /** User home dir; used to replace the home prefix of cwd with `~`. */
  homeDir?: string;
}

const SEPARATOR = ' · ';

/**
 * Compact token count: `18k`, `324k`, `1.2M`. Matches the units the agent harnesses and
 * Claude Code's own status line use, so a number seen here is comparable to one seen there.
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    // One decimal, trailing `.0` dropped: 1.2M but 2M rather than 2.0M.
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/**
 * Context-window label: `200k` / `1M`. Floors instead of rounding so a window is never
 * advertised as larger than it is (a 1M window reported as 1048576 stays `1M`, and 200k
 * stays `200k` rather than becoming `201k`).
 */
export function formatWindow(size: number): string {
  if (size >= 1_000_000) {
    return `${(Math.floor(size / 100_000) / 10).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${Math.floor(size / 1000)}k`;
}

/** Whether both context numbers are usable (a non-positive window can't yield a percentage). */
function hasContext(input: FooterInput): boolean {
  const { contextTokens, contextLength } = input;
  return (
    typeof contextLength === 'number' &&
    contextLength > 0 &&
    typeof contextTokens === 'number' &&
    contextTokens >= 0
  );
}

/** Integer percentage of the window in use, clamped to [0,100]. */
function contextPercent(input: FooterInput): number {
  const raw = Math.round((input.contextTokens! / input.contextLength!) * 100);
  return Math.min(100, Math.max(0, raw));
}

/**
 * Render the footer line: assemble each field in the given order, joined by ` · `.
 * Returns '' when no part is available.
 */
export function formatRuntimeFooter(input: FooterInput, fields: FooterField[]): string {
  const parts: string[] = [];

  for (const field of fields) {
    switch (field) {
      case 'agent': {
        if (input.agent) parts.push(input.agent);
        break;
      }

      case 'model': {
        // Short name: drop the vendor prefix at the last `/`; use as-is without `/`.
        const model = input.model;
        if (model) {
          const slash = model.lastIndexOf('/');
          const short = slash >= 0 ? model.slice(slash + 1) : model;
          // Last segment may be empty (e.g. `anthropic/`); only output if non-empty.
          if (short) parts.push(short);
        }
        break;
      }

      case 'context': {
        // `18k / 1M (2%)`. Absent entirely when the agent reported no usage — showing a
        // guessed window would be worse than showing nothing.
        if (hasContext(input)) {
          const used = formatTokens(input.contextTokens!);
          const size = formatWindow(input.contextLength!);
          parts.push(`${used} / ${size} (${contextPercent(input)}%)`);
        }
        break;
      }

      case 'contextPct': {
        // Requires contextLength>0 and contextTokens>=0; round(tokens/length*100), clamped to [0,100].
        if (hasContext(input)) parts.push(`${contextPercent(input)}%`);
        break;
      }

      case 'cwd': {
        // When homeDir is given and cwd starts with it, replace the home prefix with `~`.
        const { cwd, homeDir } = input;
        if (cwd) {
          let display = cwd;
          if (homeDir && cwd.startsWith(homeDir)) {
            display = '~' + cwd.slice(homeDir.length);
          }
          parts.push(display);
        }
        break;
      }
    }
  }

  return parts.join(SEPARATOR);
}
