import type { IpcAction } from './protocol.js';

/**
 * Reverse-command catalog: single source of truth.
 *
 * One spec drives three places, avoiding scattered lists and silent drift:
 *  - `cli.ts`: registers commander subcommands from it.
 *  - `agent-acp.ts` buildReverseHint(): generates the usage hint shown to the agent.
 *  - Execution dispatch stays in `daemon.ts` handleReverse (with exhaustive type guard).
 *
 * Adding a reverse action = one arm in the IpcAction union + one entry here; cli
 * registration and skill text follow automatically, and missing handleReverse fails to compile.
 */

export interface ReverseOption {
  /** Commander option flags, e.g. '-n, --name <name>'. */
  flags: string;
  description?: string;
  /** Value parser (e.g. parse --limit to number). */
  parse?: (value: string) => unknown;
}

export interface ReverseCommandSpec {
  /** Commander command signature, e.g. 'send-file <path>'. */
  usage: string;
  description: string;
  /** Options specific to this command (the shared --channel is added via CHANNEL_OPTION). */
  options: ReverseOption[];
  /** Build one IpcAction from positionals + options. */
  build(positionals: string[], opts: Record<string, unknown>): IpcAction;
  /** One-line usage hint for the agent (rendered by buildReverseHint when `inject` is set). */
  hint: string;
  /**
   * Whether — and where — this command's hint is injected into the agent's prompt.
   *
   * Omitted means never, which is most of the catalog, because each turned out to be a worse way
   * to do something the gateway already does:
   *  - the agent's plain text IS the reply — it streams into the chat on its own, so `send-message`
   *    and `reply` ask the model to spend a tool call re-sending what was already sent;
   *  - `edit-message` duplicates the live-edited message the daemon maintains for every turn;
   *  - `react` / `delete` / `create-thread` / `fetch-messages` describe a chat client's chrome,
   *    which is not what the model was asked to work on.
   *
   * They stay registered on the CLI (`agent-anywhere --help` lists them, scripts keep working) —
   * this flag governs one thing only: what is spent from the model's attention before it has read
   * the user's first word. The full block was ~350 tokens of "you are an IM bot" ahead of every
   * session's opening question, which is a framing the work rarely needs and never asked for.
   *
   * `'always'` — every harness is told.
   * `'no-native-ask'` — told only to harnesses that cannot ask over ACP `elicitation/create`.
   *   Exists for `ask`, which is superseded by the model's own question tool where there is one
   *   (claude) and is still the only way to get buttons where there is not (opencode, dsh).
   */
  inject?: 'always' | 'no-native-ask';
}

/** The "target channel" option shared by all reverse commands; empty = current session. */
export const CHANNEL_OPTION: ReverseOption = {
  flags: '-c, --channel <id>',
  description: 'target channel (defaults to the current session)',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Required positional accessor. Commander enforces `<arg>` presence before build() runs, so a
 * missing positional is a programmer error (catalog usage/build mismatch) — fail fast with a clear
 * message rather than letting `undefined` flow into an IpcAction field typed as string.
 */
const pos = (positionals: string[], i: number, name: string): string => {
  const v = positionals[i];
  if (v === undefined) throw new Error(`missing required argument <${name}>`);
  return v;
};

/**
 * Integer option parser for --limit / --timeout etc. Illegal input (empty,
 * non-numeric, fractional, NaN) throws a usage error instead of yielding NaN:
 * `parseInt('x',10)` returns NaN and `typeof NaN === 'number'` is true, which would
 * let NaN slip silently into numeric fields like action.limit. Fail fast at parse time.
 */
const intArg = (label: string) => (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return n;
};

/** Commander collect parser: accumulate a repeatable option (e.g. -o) into an array. */
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/**
 * fetch-messages column catalog. DEFAULT_FETCH_FIELDS is the minimal schema (AXI §2): just
 * enough to identify and read a message. ALLOWED extends it with opt-in scalar columns the
 * agent can request via --fields; `attachments` renders as a count (a nested array would break
 * the tabular TOON form). Shared with the CLI output boundary (reverse.ts) so selection and
 * rendering never drift.
 */
export const DEFAULT_FETCH_FIELDS = ['messageId', 'userId', 'content'] as const;
export const ALLOWED_FETCH_FIELDS = [
  'messageId',
  'userId',
  'content',
  'timestamp',
  'quoteId',
  'platform',
  'channelId',
  'attachments',
] as const;

/**
 * --fields parser: split a comma-separated list, validate against ALLOWED_FETCH_FIELDS, and
 * fail fast on an unknown column (AXI §6 — surface the mistake instead of silently dropping it).
 * Repeatable: accumulates across multiple --fields flags.
 */
const fieldsArg = (value: string, previous: string[] = []): string[] => {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = parts.filter((p) => !(ALLOWED_FETCH_FIELDS as readonly string[]).includes(p));
  if (invalid.length) {
    throw new Error(
      `--fields: unknown column(s) ${invalid.join(', ')}; allowed: ${ALLOWED_FETCH_FIELDS.join(', ')}`
    );
  }
  return [...previous, ...parts];
};

export const REVERSE_COMMANDS: ReverseCommandSpec[] = [
  {
    usage: 'send-message <text>',
    description: 'Send a message to the current session',
    options: [],
    build: (p, opts) => ({ kind: 'send-message', text: pos(p, 0, 'text'), channelId: str(opts.channel) }),
    hint: 'Send a message: agent-anywhere send-message "text"',
  },
  {
    usage: 'reply <messageId> <text>',
    description: 'Reply to a specific message',
    options: [],
    build: (p, opts) => ({
      kind: 'reply',
      messageId: pos(p, 0, 'messageId'),
      text: pos(p, 1, 'text'),
      channelId: str(opts.channel),
    }),
    hint: 'Reply to a message: agent-anywhere reply <messageId> "text"',
  },
  {
    usage: 'edit-message <messageId> <text>',
    description: 'Edit the text of a message you sent earlier (e.g. update a progress/status message)',
    options: [],
    build: (p, opts) => ({
      kind: 'edit-message',
      messageId: pos(p, 0, 'messageId'),
      text: pos(p, 1, 'text'),
      channelId: str(opts.channel),
    }),
    hint: 'Edit a message you sent: agent-anywhere edit-message <messageId> "new text"',
  },
  {
    usage: 'send-file <path>',
    description: 'Send a file to the current session',
    options: [
      { flags: '-n, --name <name>' },
      { flags: '--caption <caption>' },
    ],
    build: (p, opts) => ({
      kind: 'send-file',
      path: pos(p, 0, 'path'),
      name: str(opts.name),
      caption: str(opts.caption),
      channelId: str(opts.channel),
    }),
    hint: 'Send a file: agent-anywhere send-file <path> [--caption "caption"]',
    // The one capability plain text cannot reach: a file has to be uploaded, not described.
    inject: 'always',
  },
  {
    usage: 'react <messageId> <emoji>',
    description: 'Add an emoji reaction to a message',
    options: [],
    build: (p, opts) => ({
      kind: 'react',
      messageId: pos(p, 0, 'messageId'),
      emoji: pos(p, 1, 'emoji'),
      channelId: str(opts.channel),
    }),
    hint: 'Add a reaction: agent-anywhere react <messageId> <emoji>',
  },
  {
    usage: 'delete <messageId>',
    description: 'Delete a message',
    options: [],
    build: (p, opts) => ({ kind: 'delete', messageId: pos(p, 0, 'messageId'), channelId: str(opts.channel) }),
    hint: 'Delete a message: agent-anywhere delete <messageId>',
  },
  {
    usage: 'fetch-messages',
    description: 'Fetch channel message history (TOON table written to stdout for the agent to read)',
    options: [
      { flags: '-l, --limit <n>', description: 'number of messages', parse: intArg('--limit') },
      { flags: '--before <messageId>' },
      {
        flags: '-f, --fields <list>',
        description: `comma-separated columns (default ${DEFAULT_FETCH_FIELDS.join(',')}; available ${ALLOWED_FETCH_FIELDS.join(',')})`,
        parse: fieldsArg,
      },
    ],
    build: (_positionals, opts) => ({
      kind: 'fetch-messages',
      channelId: str(opts.channel),
      limit: typeof opts.limit === 'number' ? opts.limit : undefined,
      before: str(opts.before),
      fields: Array.isArray(opts.fields) ? (opts.fields as string[]) : undefined,
    }),
    hint: 'Fetch history context: agent-anywhere fetch-messages [--limit 20] [--before <messageId>] [--fields content,timestamp] (writes a TOON table to stdout)',
  },
  {
    usage: 'create-thread <messageId> <name>',
    description: 'Create a thread from a specific message',
    options: [],
    build: (p, opts) => ({
      kind: 'create-thread',
      messageId: pos(p, 0, 'messageId'),
      name: pos(p, 1, 'name'),
      channelId: str(opts.channel),
    }),
    hint: 'Create a thread: agent-anywhere create-thread <messageId> <threadName> (returns {threadId})',
  },
  {
    usage: 'ask <prompt>',
    description: 'Ask a clarifying question (blocking: sends a message with buttons and waits for the user to choose, returning the chosen label text to stdout)',
    options: [
      // -o is repeatable: one button per label, collected into an array.
      { flags: '-o, --option <label>', description: 'an available option (repeatable)', parse: collect },
      { flags: '--timeout <ms>', description: 'wait timeout (milliseconds)', parse: intArg('--timeout') },
    ],
    build: (p, opts) => ({
      kind: 'ask',
      prompt: pos(p, 0, 'prompt'),
      options: Array.isArray(opts.option) ? (opts.option as string[]) : [],
      timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : undefined,
      channelId: str(opts.channel),
    }),
    // The hint is what reaches an agent's prompt, so it has to carry the two things that were
    // learned the hard way: `--timeout` exists, and a blank answer is "nobody clicked", not
    // "this command does not work". An agent that reads the blank as a malfunction stops using
    // ask entirely — which is worse than the unanswered question it started with.
    hint:
      'Ask a clarifying question (blocks until the user chooses): agent-anywhere ask "question" ' +
      '-o optionA -o optionB [--timeout <ms>, default 10min] (writes the chosen label to stdout; ' +
      'empty stdout plus a stderr note means nobody clicked in time — the question WAS delivered, ' +
      'so follow up in plain text instead of assuming the command is broken)',
    // Only where the harness has no question tool of its own. On claude the model asks over ACP
    // elicitation and this hint would advertise a second, worse way to do the same thing; on
    // opencode and dsh (probed 2026-09-11: neither sends any reverse request) it is the only way
    // to put buttons in front of the user, and without it they can only ask in prose.
    inject: 'no-native-ask',
  },
];
