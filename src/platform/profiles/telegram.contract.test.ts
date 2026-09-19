// Telegram 429 contract test.
//
// `classifyTelegramError` (telegram.ts) recovers a flood wait by regex over an error MESSAGE,
// because `@satorijs/adapter-telegram`'s Internal.define rethrows a brand-new Error and drops
// `response.data.parameters.retry_after` — the structured field — on the floor. That makes the
// message text load-bearing, and nobody upstream promised to keep it stable.
//
// So this drives the REAL Internal wrapper against Telegram's actual 429 envelope, through both
// of the two branches that produce the string (an `{ok:false}` body, and an HTTP rejection whose
// `response.data` carries the same), and asserts the profile still recovers 229 s from it.
//
// If a dep upgrade reformats the message — or, better, starts preserving `parameters.retry_after`
// so the regex can be deleted — this goes red instead of the daemon silently reverting to a blind
// 10 s backoff against a 229 s wait and re-earning the flood limit 22 times over.
import { describe, it, expect } from 'vitest';
import * as telegramAdapter from '@satorijs/adapter-telegram';

import { RateLimitedError } from '../../core/outbound-errors.js';
import { createTelegramProfile } from './telegram.js';

/**
 * `Internal` is a real runtime export but is not declared as a value in the package's .d.ts (only
 * as a `Telegram.Internal` interface), so it has to be reached through the namespace. That the
 * class is undeclared is itself part of the point of this file: nothing here is API we are
 * promised.
 */
const Internal = (telegramAdapter as unknown as {
  Internal: new (bot: unknown) => { editMessageText(data: unknown): Promise<unknown> };
}).Internal;

/** Telegram's real 429 response body (Bot API: description repeats the retry_after seconds). */
const FLOOD_BODY = {
  ok: false,
  error_code: 429,
  description: 'Too Many Requests: retry after 229',
  parameters: { retry_after: 229 },
};

/**
 * An Internal bound to a fake `bot.http`.
 *
 * `post` decides which of Internal.define's two throw sites is exercised: `resolve` returns the
 * body (the `if (ok)` branch falls through to the first throw), `reject` throws an axios-shaped
 * error (caught and re-thrown by the second).
 */
function internalWith(mode: 'resolve' | 'reject'): { editMessageText(data: unknown): Promise<unknown> } {
  const bot = {
    logger: { debug: () => undefined },
    http: {
      post: async () => {
        if (mode === 'resolve') return { ...FLOOD_BODY, data: FLOOD_BODY };
        throw Object.assign(new Error('Request failed with status code 429'), {
          response: { data: FLOOD_BODY },
        });
      },
    },
  };
  return new Internal(bot);
}

describe('telegram 429 contract (satori discards retry_after; the message text is the witness)', () => {
  const profile = createTelegramProfile();

  it.each(['resolve', 'reject'] as const)(
    'the real Internal.define wrapper still formats the flood as a parseable string (%s branch)',
    async (mode) => {
      const thrown = await internalWith(mode)
        .editMessageText({})
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(Error);
      // The exact shape the regex depends on: `Telegram API error <code>. <description>`.
      expect((thrown as Error).message).toBe('Telegram API error 429. Too Many Requests: retry after 229');
      // The reason the regex exists at all: neither the structured field nor a cause survives.
      expect((thrown as Error).cause).toBeUndefined();
      expect(thrown).not.toHaveProperty('response');
    }
  );

  it('the profile recovers the stated wait from that exact string', async () => {
    const thrown = await internalWith('reject')
      .editMessageText({})
      .catch((e: unknown) => e);

    const classified = profile.classifyError!(thrown);
    expect(classified).toBeInstanceOf(RateLimitedError);
    expect((classified as RateLimitedError).retryAfterMs).toBe(229_000);
  });
});
