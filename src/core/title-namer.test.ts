import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TITLE_CHARS,
  buildTitleMessages,
  fallbackTitle,
  generateTitle,
  sanitizeTitle,
} from './title-namer.js';

/**
 * The naming call and the cleanup around it.
 *
 * Everything here is about a model not doing quite what it was told: answering in quotes, prefixing
 * `Title:`, explaining itself on a second line, ending on a full stop. None of that is worth
 * discarding an otherwise good name over, so it is cleaned rather than rejected — and the tests are
 * the record of which deviations are tolerated.
 */

const CFG = { baseUrl: 'http://namer.test/v1', apiKey: 'k', model: 'flash', timeoutMs: 1000 };

afterEach(() => vi.unstubAllGlobals());

/** A fetch that answers with one OpenAI-compatible completion. */
function reply(content: string): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('sanitizeTitle', () => {
  it('passes a well-formed title through unchanged', () => {
    expect(sanitizeTitle('Telegram 话题自动改名')).toBe('Telegram 话题自动改名');
  });

  it('takes the first line when the model explains itself underneath', () => {
    expect(sanitizeTitle('Fix the ask timeout\n\nThis names the topic after…')).toBe('Fix the ask timeout');
  });

  it('skips leading blank lines rather than returning nothing', () => {
    expect(sanitizeTitle('\n\n  Fix the ask timeout')).toBe('Fix the ask timeout');
  });

  it.each([
    ['"Fix the ask timeout"', 'Fix the ask timeout'],
    ["'Fix the ask timeout'", 'Fix the ask timeout'],
    ['“修复超时”', '修复超时'],
    ['「修复超时」', '修复超时'],
    ['《修复超时》', '修复超时'],
  ])('unwraps %s', (raw, want) => {
    expect(sanitizeTitle(raw)).toBe(want);
  });

  // An apostrophe is not a quote to strip: the pair has to actually wrap the whole string.
  it('leaves an apostrophe inside a title alone', () => {
    expect(sanitizeTitle("Fix the daemon's timeout")).toBe("Fix the daemon's timeout");
  });

  it.each([
    ['Title: Fix the ask timeout', 'Fix the ask timeout'],
    ['标题：修复超时', '修复超时'],
    ['主题: 修复超时', '修复超时'],
  ])('drops the label in %s', (raw, want) => {
    expect(sanitizeTitle(raw)).toBe(want);
  });

  it('drops the sentence punctuation a model adds out of habit', () => {
    expect(sanitizeTitle('修复超时问题。')).toBe('修复超时问题');
    expect(sanitizeTitle('Fix the ask timeout.')).toBe('Fix the ask timeout');
  });

  it('collapses the whitespace inside', () => {
    expect(sanitizeTitle('Fix   the\task  timeout')).toBe('Fix the ask timeout');
  });

  // A limit, not a target: the model is asked for something far shorter, and this is for when it
  // ignores that. A topic name only earns its place in the column if it reads at a glance.
  it('cuts an over-long answer to length', () => {
    const out = sanitizeTitle('x'.repeat(200));
    expect(out).toHaveLength(MAX_TITLE_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('reports nothing usable as empty, so the caller can fall back', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('   \n  ')).toBe('');
    expect(sanitizeTitle('。。。')).toBe('');
  });
});

describe('fallbackTitle', () => {
  it('keeps a short message whole', () => {
    expect(fallbackTitle('帮我看看这个报错')).toBe('帮我看看这个报错');
  });

  it('flattens the newlines of a multi-line message', () => {
    expect(fallbackTitle('first line\n\nsecond line')).toBe('first line second line');
  });

  it('cuts a long one to 40 characters including the ellipsis', () => {
    const out = fallbackTitle('a'.repeat(100));
    expect(out).toBe(`${'a'.repeat(39)}…`);
    expect(out).toHaveLength(40);
  });
});

describe('buildTitleMessages', () => {
  it('sends the message as the user turn, with the instructions as system', () => {
    const m = buildTitleMessages('帮我看看这个报错');
    expect(m.map((x) => x.role)).toEqual(['system', 'user']);
    expect(m[1]!.content).toBe('帮我看看这个报错');
  });

  // The subject is established in the opening sentences; the remaining 40KB of a pasted log adds
  // cost and tempts the model to name the topic after an incidental line deep inside it.
  it('caps how much of a pasted log is sent', () => {
    const m = buildTitleMessages('x'.repeat(10_000));
    expect(m[1]!.content).toHaveLength(2000);
  });
});

describe('generateTitle', () => {
  it('posts to <baseUrl>/chat/completions with the key and model', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spy = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'A name' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    expect(await generateTitle(CFG, 'hello', spy)).toBe('A name');
    expect(calls[0]!.url).toBe('http://namer.test/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('flash');
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const calls: string[] = [];
    const spy = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ choices: [{ message: { content: 'A name' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await generateTitle({ ...CFG, baseUrl: 'http://namer.test/v1/' }, 'hello', spy);
    expect(calls[0]).toBe('http://namer.test/v1/chat/completions');
  });

  it('cleans the answer on the way out', async () => {
    expect(await generateTitle(CFG, 'hello', reply('"Fix the ask timeout."'))).toBe('Fix the ask timeout');
  });

  // Every one of these is "the conversation keeps its old name", never "the turn fails".
  it('returns undefined on a transport error', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await generateTitle(CFG, 'hello', boom)).toBeUndefined();
  });

  it('returns undefined on a non-2xx', async () => {
    const denied = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => '{"error":"bad key"}',
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await generateTitle(CFG, 'hello', denied)).toBeUndefined();
  });

  it('returns undefined on a body that is not a completion', async () => {
    const odd = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ detail: 'not what you asked for' }),
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await generateTitle(CFG, 'hello', odd)).toBeUndefined();
  });

  it('returns undefined when the model answers with nothing usable', async () => {
    expect(await generateTitle(CFG, 'hello', reply('   '))).toBeUndefined();
  });

  it('gives up at the configured deadline instead of hanging the naming', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, rejectPromise) => {
        init.signal?.addEventListener('abort', () => rejectPromise(new Error('aborted')));
      })) as unknown as typeof fetch;
    expect(await generateTitle({ ...CFG, timeoutMs: 20 }, 'hello', hang)).toBeUndefined();
  });
});
