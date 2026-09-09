// Name a conversation by asking a small LLM to summarise what it is about.
//
// ── Why a model call, for a topic name ──────────────────────────────────────────────────────────
// The two sources tried before this both produced names the user could not act on.
//
// The harness's own ACP `session_info_update` title was accurate but never settled: claude-agent-acp
// regenerates it as the session moves on, so the topic name tracked "what was said most recently"
// rather than what the topic is FOR — and only one of the four deployed harnesses emits it at all.
//
// The fallback for the other three was the first 39 characters of the opening message, which is not
// a summary but a substring: "帮我看下这个报错" became the name of a topic, and so did the first line
// of a pasted stack trace.
//
// A one-sentence summarisation is the smallest thing that actually answers "what is this topic
// about", and it is cheap enough to spend once per conversation (~60 tokens on a flash-tier model).
// Once, because a name that keeps moving is worse than one that is slightly off: the user scans the
// topic column by memory of where things are.
//
// Everything here is best-effort by construction. A conversation whose name never changed is a
// cosmetic problem; a turn that fails because a naming call did is not, so nothing in this module
// throws and the caller never awaits it on the reply path.

/** The OpenAI-compatible endpoint used to generate names, or undefined to fall back to a substring. */
export interface TitleLlmConfig {
  /** Base URL up to and including the version segment, e.g. `https://host/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/**
 * Cap on the generated subject, before the `[<agent>] ` tag is prepended.
 *
 * Telegram allows 128 characters in a forum topic name, but that is a limit, not a target — a name
 * only earns its place in the topic column if it can be read at a glance. The model is asked for
 * something far shorter than this; the cap is for when it ignores that.
 */
export const MAX_TITLE_CHARS = 48;

/**
 * How much of the opening message is worth sending.
 *
 * The subject of a conversation is established in its first sentences; the remaining 40KB of a
 * pasted log adds cost and, worse, tempts the model to name the topic after an incidental line
 * deep inside it.
 */
const MAX_SEED_CHARS = 2000;

/** Length rule for the substring fallback — kept exactly as it was before the model call existed. */
const FALLBACK_CHARS = 40;

/**
 * Name a conversation from its opening message without asking anything: the message itself, cut to
 * length.
 *
 * Used when no `title.llm` is configured, and when the call fails. It is a poor name — that is the
 * whole reason the model call exists — but it is a name, and recording one is what stops the
 * gateway retrying on every subsequent turn.
 */
export function fallbackTitle(seed: string): string {
  const flat = seed.replace(/\s+/g, ' ').trim();
  if (flat.length <= FALLBACK_CHARS) return flat;
  return flat.slice(0, FALLBACK_CHARS - 1) + '…';
}

/**
 * Turn whatever the model replied with into something that can be a topic name.
 *
 * Instructions notwithstanding, a model asked for a bare title will sometimes wrap it in quotes,
 * prefix it with `Title:`, or answer in two lines with the second explaining the first. None of
 * that is a failure worth discarding the answer over, so it is cleaned rather than rejected.
 *
 * Returns '' when nothing usable is left, which the caller reads as "the call did not work".
 */
export function sanitizeTitle(raw: string): string {
  // First non-empty line: a model that explains itself does so on the lines after the answer.
  let s = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  s = s.replace(/^(?:title|标题|主题)\s*[:：]\s*/i, '');
  // Paired wrapping quotes only — an apostrophe inside a title is not a quote to strip.
  const quotes: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['《', '》'],
  ];
  for (const [open, close] of quotes) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim();
      break;
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  // A title is a noun phrase; the sentence-ending punctuation a model adds out of habit is noise.
  s = s.replace(/[.。!！?？,，、;；:：]+$/u, '').trim();
  if (s.length > MAX_TITLE_CHARS) s = s.slice(0, MAX_TITLE_CHARS - 1).trim() + '…';
  return s;
}

/** The chat messages sent to name one conversation. Exported so the prompt is testable as data. */
export function buildTitleMessages(seed: string): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You name chat topics. The user message is the opening request someone sent to a coding agent.',
        'Reply with a short title naming what the topic is about, and nothing else.',
        '',
        'Rules:',
        '- Output the title only: no quotes, no "Title:" prefix, no trailing punctuation, no explanation.',
        '- Write it in the same language the user wrote in.',
        '- At most 8 words, or 20 characters for Chinese, Japanese or Korean.',
        '- Name the subject, not the act of asking: "Telegram 话题自动改名" beats "用户想改标题".',
        '- If the message is a pasted log or error, name what is failing.',
        '- If it is too short or vague to summarise, shorten the user\'s own words instead of inventing a subject.',
      ].join('\n'),
    },
    { role: 'user', content: seed.slice(0, MAX_SEED_CHARS) },
  ];
}

/** Pull the assistant text out of an OpenAI-compatible completion, tolerating anything else. */
function completionText(body: unknown): string {
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Ask the configured model for a name. Returns undefined when it could not produce one — a
 * transport error, a non-2xx, an unexpected body, or a reply that sanitised down to nothing.
 *
 * `fetch` is injectable for tests only; production always uses the global one, which the daemon has
 * already pointed at the system proxy (see core/proxy.ts).
 */
export async function generateTitle(
  cfg: TitleLlmConfig,
  seed: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: buildTitleMessages(seed),
        // Room for a short answer AND for a thinking-tier model to spend a few tokens before it:
        // a cap tight enough to fit only the title is the one that returns an empty string.
        max_tokens: 200,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      // The body usually carries the actual reason (bad key, unknown model, no quota) and is the
      // difference between a fixable report and "naming stopped working".
      const detail = await res.text().catch(() => '');
      console.warn(`[title] naming call failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return undefined;
    }
    const title = sanitizeTitle(completionText(await res.json()));
    if (!title) {
      console.warn('[title] naming call returned nothing usable');
      return undefined;
    }
    return title;
  } catch (e) {
    console.warn(`[title] naming call failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
