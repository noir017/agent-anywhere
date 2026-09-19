import { describe, expect, it } from 'vitest';
import { formatButtonId, parseButtonId } from './button-id.js';

/**
 * The id grammar every menu shares. Worth its own file because it is now built in `core/model-menu.ts`
 * and parsed in `daemon/daemon.ts` — the round trip is the only thing holding those two together.
 */
describe('button id grammar', () => {
  it('round-trips through every prefix in use', () => {
    for (const prefix of ['ask:', 'cmd:', 'mdl:', 'mpg:']) {
      const id = formatButtonId(prefix, 'ab12cd34', 7);
      expect(parseButtonId(id, prefix)).toEqual({ reqId: 'ab12cd34', n: 7 });
    }
  });

  it('refuses another menu\'s id rather than misreading it', () => {
    expect(parseButtonId(formatButtonId('mdl:', 'r1', 0), 'mpg:')).toBeNull();
    expect(parseButtonId(formatButtonId('ask:', 'r1', 0), 'cmd:')).toBeNull();
  });

  it('rejects a missing reqId, a missing index, and a non-numeric one', () => {
    // Number('') is 0, so an empty index would silently become "the first button" without the guard.
    expect(parseButtonId('mdl::3', 'mdl:')).toBeNull();
    expect(parseButtonId('mdl:r1:', 'mdl:')).toBeNull();
    expect(parseButtonId('mdl:r1:x', 'mdl:')).toBeNull();
    expect(parseButtonId('mdl:r1:-1', 'mdl:')).toBeNull();
    expect(parseButtonId('mdl:r1', 'mdl:')).toBeNull();
    expect(parseButtonId('', 'mdl:')).toBeNull();
  });

  it('takes the LAST colon as the separator, so a reqId containing one still parses', () => {
    expect(parseButtonId('mdl:a:b:4', 'mdl:')).toEqual({ reqId: 'a:b', n: 4 });
  });
});
