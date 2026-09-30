import type { IpcAction } from './protocol.js';
import { DEFAULT_CHANNEL_LIMIT } from './protocol.js';

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
  /**
   * Which `agent-anywhere help <topic>` page documents this command. Required, so a new command
   * cannot be added without deciding where an agent will find it — the help pages are how
   * everything that is NOT injected gets discovered (see HELP_TOPICS).
   */
  topic: HelpTopicName;
}

/**
 * The pages of `agent-anywhere help`: the on-demand half of what the agent is told.
 *
 * ── Why the catalog is loaded on demand ───────────────────────────────────────────────────────
 * The injected hint (agent-common.ts buildReverseHint) names send-file and — on harnesses that
 * cannot ask — ask, and one more line: a pointer here, carrying the few `pointer` phrases below so a
 * model can map "every morning at 8…" onto a page it has never read. Everything else costs nothing
 * until the model runs `agent-anywhere help <topic>`, which prints that topic's commands (from the
 * specs, so they cannot drift) and its rules. It is the skill pattern — a one-line description in
 * context, the body loaded when relevant — done in the CLI, because every harness here has a shell
 * and not every harness has skills (and the ones that do keep them in different places).
 *
 * MCP tools were the other candidate and lose on the harnesses that matter: only Claude Code defers
 * MCP tool definitions, and only past a size threshold; opencode, codex and agy would carry the full
 * schemas in every request, which is the opposite of the point.
 */
export type HelpTopicName = 'files' | 'schedule' | 'channels' | 'history' | 'messages' | 'threads' | 'ask' | 'voice';

export interface HelpTopic {
  name: HelpTopicName;
  /** One line on the index page. */
  summary: string;
  /**
   * The phrase this topic contributes to the injected pointer line, if any. Only topics an agent
   * could not guess exist belong there; three phrases is already the budget.
   */
  pointer?: string;
  /** What to know beyond each command's usage line: the rules, the traps, the defaults. */
  notes: string[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    name: 'files',
    summary: 'Send a file or image into the chat',
    notes: ['Relative paths and ~ resolve against your working directory. --name overrides the displayed filename.'],
  },
  {
    name: 'schedule',
    summary: 'Scheduled and recurring tasks that survive restarts — an agent prompt or a bash command, output to any chat',
    pointer: 'scheduled/recurring tasks that survive restarts',
    notes: [
      'Use this rather than a scheduling tool built into your own harness: those live inside your process, which the gateway stops after an idle hour and on every restart. Tasks here are kept on disk by the gateway and run from it.',
      'When the time, the time zone, or where the output should go is not clear from what the user said, ask before adding. The gateway posts a card with the task\'s details when it is registered, changed or deleted; the user can list, pause and delete tasks with /setting schedule.',
      '--prompt with --session fixed (the default): each run is a turn in THIS conversation (or the one --channel names), with the agent answering it — context accumulates and the user can follow up in place. A fixed-session task lives 24h from registration, then expires; anything longer needs --session new.',
      '--prompt with --session new: every run is a fresh session, in a new topic where the platform can open one (web UI, Telegram forum groups, Discord), otherwise posted straight into the chat. --agent picks who answers; --cwd where it starts.',
      '--bash: the gateway runs the command with `bash -lc` in --cwd (default: your working directory) and posts the exit code, duration and the end of the output; long output is attached as a file. --timeout defaults to 10m, at most 6h.',
      '--at takes +30m / +2h / 08:00 (the next time the clock reads that) / "2026-10-01 08:00" / an ISO time with a zone. --cron takes 5 fields (minute hour day month weekday). Both are read in --tz, default the gateway\'s own zone.',
      '--channel is where output goes (ids from `agent-anywhere channels`); default this conversation.',
      'A run missed while the gateway was down is made once if it is less than an hour late, otherwise recorded as missed. A run that comes due while the previous one is still going is skipped.',
      '`add` and `show` print the task id; `list` shows every task with its next run and last result; pause / resume / run (run it now, once) / rm take the id.',
    ],
  },
  {
    name: 'channels',
    summary: 'Post to another chat or topic, on any platform',
    pointer: 'posting to other chats',
    notes: [
      'Every command takes --channel <id>. A bare <channel>[/<thread>] stays on the platform you are answering on; <instance>:<channel>[/<thread>] (what `channels` prints) names any platform.',
      'The list only holds places the gateway has answered in — most platforms cannot enumerate a bot\'s chats. kind=channel rows are chat roots (where a new topic would be opened); current=true is this conversation.',
    ],
  },
  {
    name: 'history',
    summary: 'Read earlier messages in the chat',
    pointer: 'chat history',
    notes: [
      'Use it when the user refers to something outside your context ("the file I sent above"). Content is cut at 500 characters per message; `--fields attachments` adds the attachment URLs.',
      'Page further back with --before <the oldest messageId you have>. count: 0 means the channel really is empty.',
    ],
  },
  {
    name: 'messages',
    summary: 'Extra messages, quote-replies, edits, reactions and deletes',
    notes: [
      'Your plain reply already streams into the chat — never re-send it with send-message, or the user reads it twice. These are for something extra: a completion notice from a background job, a status message you keep editing.',
      'send-message, reply and send-file print the messageId; keep it if you will edit, react to or delete that message.',
    ],
  },
  {
    name: 'threads',
    summary: 'Open a thread from a message',
    notes: ['Prints the thread id; pass it as --channel to post inside the thread.'],
  },
  {
    name: 'ask',
    summary: 'A blocking button question — only if you have no question tool of your own',
    notes: [
      'If your harness has a question tool (Claude Code\'s AskUserQuestion), use that: the gateway renders it as the same buttons.',
      'stdout is the chosen label, or the user\'s typed answer. Empty stdout plus a stderr note means nobody answered in time — the question WAS delivered; follow up in plain text.',
    ],
  },
  {
    name: 'voice',
    summary: 'What a voice message actually said',
    notes: [
      'Some user messages were spoken: the user saw the transcript and approved it, so treat it as what they said. This is for the rare message that reads like a mishearing.',
    ],
  },
];

/** The injected pointer line's content: the topics worth advertising, in HELP_TOPICS order. */
export function helpPointer(): string {
  const phrases = HELP_TOPICS.flatMap((t) => (t.pointer ? [t.pointer] : []));
  return `More, loaded when you need them — ${phrases.join(', ')}: agent-anywhere help`;
}

/** `agent-anywhere help`: one line per topic. */
export function renderHelpIndex(): string {
  const width = Math.max(...HELP_TOPICS.map((t) => t.name.length));
  return [
    'Gateway tools. Your plain replies reach the user on their own; these are for what text cannot do.',
    'Run `agent-anywhere help <topic>` for a topic\'s commands and rules.',
    '',
    ...HELP_TOPICS.map((t) => `  ${t.name.padEnd(width)}  ${t.summary}`),
  ].join('\n');
}

/** `agent-anywhere help <topic>`: its commands, rendered from the specs, then its notes. */
export function renderHelpTopic(name: string): string | undefined {
  const topic = HELP_TOPICS.find((t) => t.name === name.toLowerCase());
  if (!topic) return undefined;
  const lines = [`${topic.name} — ${topic.summary}`, ''];
  for (const spec of REVERSE_COMMANDS.filter((c) => c.topic === topic.name)) {
    lines.push(`  agent-anywhere ${spec.usage}`, `    ${spec.description}`);
    for (const opt of [...spec.options, CHANNEL_OPTION]) lines.push(`      ${opt.flags}${opt.description ? `  ${opt.description}` : ''}`);
    lines.push('');
  }
  if (topic.notes.length) lines.push('Notes:', ...topic.notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}

/** The "target channel" option shared by all reverse commands; empty = current session. */
export const CHANNEL_OPTION: ReverseOption = {
  flags: '-c, --channel <id>',
  description:
    'target channel: <channel>[/<thread>] on this platform, or <instance>:<channel>[/<thread>] on any (ids from `agent-anywhere channels`; defaults to the current conversation)',
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

/**
 * Duration parser for --timeout on schedule: `90s`, `10m`, `1h`, or bare milliseconds. Units
 * because a bash task's limit is minutes, and `--timeout 600000` is a number nobody checks.
 */
const durationArg = (value: string): number => {
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(value.trim());
  if (!m) throw new Error(`--timeout must be a duration like 90s, 10m or 1h, got ${JSON.stringify(value)}`);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? 'ms').toLowerCase() as 'ms' | 's' | 'm' | 'h'];
  return Number(m[1]) * unit;
};

/** `schedule add`'s own options, by commander's camel-cased key — refused on every other action. */
const SCHEDULE_ADD_KEYS = ['cron', 'at', 'tz', 'name', 'prompt', 'bash', 'agent', 'session', 'cwd', 'timeout'] as const;

function buildScheduleAdd(opts: Record<string, unknown>): IpcAction {
  const session = str(opts.session);
  if (session !== undefined && session !== 'fixed' && session !== 'new') {
    throw new Error(`--session must be fixed or new, got ${JSON.stringify(session)}`);
  }
  return {
    kind: 'schedule-add',
    channelId: str(opts.channel),
    name: str(opts.name),
    cron: str(opts.cron),
    at: str(opts.at),
    tz: str(opts.tz),
    prompt: str(opts.prompt),
    bash: str(opts.bash),
    agent: str(opts.agent),
    session,
    cwd: str(opts.cwd),
    timeoutMs: typeof opts.timeout === 'number' ? opts.timeout : undefined,
  };
}

/** `schedule <action> [id]` → one IpcAction, refusing flags that do not belong to the action. */
function buildSchedule(p: string[], opts: Record<string, unknown>): IpcAction {
  const action = pos(p, 0, 'action').toLowerCase();
  if (action === 'add') {
    if (p[1] !== undefined) throw new Error('schedule add takes no id; its options describe the task');
    return buildScheduleAdd(opts);
  }
  const stray = SCHEDULE_ADD_KEYS.find((k) => opts[k] !== undefined);
  if (stray) throw new Error(`--${stray} only applies to \`schedule add\``);
  if (str(opts.channel) !== undefined) throw new Error(`--channel only applies to \`schedule add\` (where output goes)`);
  const id = (): string => {
    const v = p[1]?.replace(/^#/, '');
    if (!v) throw new Error(`schedule ${action} needs a task id (\`agent-anywhere schedule list\` shows them)`);
    return v;
  };
  switch (action) {
    case 'list':
    case 'ls':
      return { kind: 'schedule-list' };
    case 'show':
      return { kind: 'schedule-list', id: id() };
    case 'pause':
    case 'resume':
    case 'run':
      return { kind: 'schedule-op', id: id(), op: action };
    case 'rm':
    case 'remove':
    case 'delete':
      return { kind: 'schedule-op', id: id(), op: 'remove' };
    default:
      throw new Error(`unknown schedule action "${action}"; use add | list | show | pause | resume | run | rm`);
  }
}

export const REVERSE_COMMANDS: ReverseCommandSpec[] = [
  {
    usage: 'send-message <text>',
    topic: 'messages',
    description: 'Send a message to the current session',
    options: [],
    build: (p, opts) => ({ kind: 'send-message', text: pos(p, 0, 'text'), channelId: str(opts.channel) }),
    hint: 'Send a message: agent-anywhere send-message "text"',
  },
  {
    usage: 'reply <messageId> <text>',
    topic: 'messages',
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
    topic: 'messages',
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
    topic: 'files',
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
    topic: 'messages',
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
    topic: 'messages',
    description: 'Delete a message',
    options: [],
    build: (p, opts) => ({ kind: 'delete', messageId: pos(p, 0, 'messageId'), channelId: str(opts.channel) }),
    hint: 'Delete a message: agent-anywhere delete <messageId>',
  },
  {
    usage: 'fetch-messages',
    topic: 'history',
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
    topic: 'threads',
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
    topic: 'ask',
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
      '-o optionA -o optionB [--timeout <ms>, default 1h] (writes the chosen label to stdout; ' +
      'empty stdout plus a stderr note means nobody clicked in time — the question WAS delivered, ' +
      'so follow up in plain text instead of assuming the command is broken)',
    // Only where the harness has no question tool of its own. On claude the model asks over ACP
    // elicitation and this hint would advertise a second, worse way to do the same thing; on
    // opencode and dsh (probed 2026-09-11: neither sends any reverse request) it is the only way
    // to put buttons in front of the user, and without it they can only ask in prose.
    inject: 'no-native-ask',
  },
  {
    usage: 'voice-log',
    topic: 'voice',
    description:
      "List this conversation's recent voice-message transcripts: what the user said, what was sent on, and the saved audio file (TOON table on stdout)",
    options: [{ flags: '-l, --limit <n>', description: 'number of transcripts (default 10)', parse: intArg('--limit') }],
    build: (_positionals, opts) => {
      // The log is keyed by conversation and read for the caller's own; there is no other channel
      // to point it at, so a --channel is refused rather than silently ignored.
      if (str(opts.channel) !== undefined) {
        throw new Error("voice-log reads this conversation's own transcripts; --channel does not apply");
      }
      return { kind: 'voice-log', limit: typeof opts.limit === 'number' ? opts.limit : undefined };
    },
    hint: "Check what a voice message actually said: agent-anywhere voice-log [--limit 10] (this conversation's transcripts, their outcome, and the saved audio path)",
    // Deliberately never injected. A confirmed transcript reaches the agent as the user's own typed
    // words — the user read and approved them — so telling every session that some messages were
    // spoken would only invite second-guessing text that has already been checked. The command is
    // for the rare turn where a message reads like a mishearing; `--help` and the bundled skill
    // document it.
  },
  {
    usage: 'channels',
    topic: 'channels',
    description:
      'List the chats and topics this gateway can post to, with the ids --channel accepts (TOON table on stdout)',
    options: [
      { flags: '-p, --platform <instance>', description: 'only this platform instance (e.g. tg, web)' },
      { flags: '-q, --query <text>', description: 'filter by id, title or agent' },
      {
        flags: '-l, --limit <n>',
        description: `number of topics (default ${DEFAULT_CHANNEL_LIMIT}, most recent first)`,
        parse: intArg('--limit'),
      },
    ],
    build: (_positionals, opts) => {
      // Lists places rather than acting in one, so a target would mean nothing — refused, not ignored.
      if (str(opts.channel) !== undefined) {
        throw new Error('channels lists places to post to; --channel does not apply');
      }
      return {
        kind: 'list-channels',
        platform: str(opts.platform),
        query: str(opts.query),
        limit: typeof opts.limit === 'number' ? opts.limit : undefined,
      };
    },
    hint: 'List places you can post to: agent-anywhere channels [--platform tg] [--query text] (ids for --channel)',
  },
  {
    usage: 'schedule <action> [id]',
    topic: 'schedule',
    description:
      'Scheduled tasks kept by the gateway (they survive restarts): add | list | show <id> | pause <id> | resume <id> | run <id> | rm <id>',
    options: [
      { flags: '--cron <expr>', description: 'add: recurring, 5-field cron, e.g. "0 8 * * *"' },
      { flags: '--at <time>', description: 'add: once — +30m, +2h, 08:00, "2026-10-01 08:00", or ISO with a zone' },
      { flags: '--tz <zone>', description: "add: IANA zone for --cron/--at (default: the gateway's own)" },
      { flags: '--prompt <text>', description: 'add: an agent runs this' },
      { flags: '--bash <command>', description: 'add: the gateway runs this with bash and posts the output' },
      { flags: '--session <mode>', description: 'add: fixed = a turn in this conversation, 24h max (default) | new = a fresh session each run' },
      { flags: '--agent <id>', description: "add: who runs --prompt (default: this conversation's agent)" },
      { flags: '--name <name>', description: 'add: short name for lists and cards' },
      { flags: '--cwd <dir>', description: 'add: working directory for --bash or --session new' },
      { flags: '--timeout <duration>', description: 'add: --bash time limit, e.g. 90s, 10m (default 10m, max 6h)', parse: durationArg },
    ],
    build: buildSchedule,
    hint: 'Scheduled tasks that survive restarts: agent-anywhere schedule add --cron "0 8 * * *" --prompt "…" [--session new] (see agent-anywhere help schedule)',
  },
];
