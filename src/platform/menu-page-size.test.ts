import { describe, expect, it } from 'vitest';
import { PAGE_SIZE, PAGE_SIZE_MAX, resolvePageSize } from '../core/paging.js';
import { createDiscordProfile } from './profiles/discord.js';
import { createTelegramProfile } from './profiles/telegram.js';
import { createSlackProfile } from './profiles/slack.js';
import { createLarkProfile } from './profiles/lark.js';
import { createQQProfile } from './profiles/qq.js';
import { createLineProfile } from './profiles/line.js';
import { createWecomProfile } from './profiles/wecom.js';
import { createDingtalkProfile } from './profiles/dingtalk.js';
import type { PlatformProfile } from './profile.js';

/**
 * What each platform says a menu page may hold.
 *
 * `menuPageSize` is the kind of field that is only ever wrong once, silently: a number too large
 * for a platform does not degrade, it makes the platform reject the whole message — and the way
 * anyone finds out is `/cd` answering nothing. So the declarations are checked here rather than
 * trusted, against the two things that are true of all of them.
 *
 * Mirrors PROFILES in platform-factory.ts, which is not exported. A platform added there and not
 * here simply is not covered; that is the same gap every other per-profile test has, and the fix if
 * it starts to matter is to export the map, not to weaken these.
 */
const PROFILES: Array<[string, () => PlatformProfile]> = [
  ['discord', createDiscordProfile],
  ['telegram', createTelegramProfile],
  ['slack', createSlackProfile],
  ['lark', createLarkProfile],
  ['qq', createQQProfile],
  ['line', createLineProfile],
  ['wecom', createWecomProfile],
  ['dingtalk', createDingtalkProfile],
];

describe('declared menu page sizes', () => {
  it.each(PROFILES)('%s declares a size core would use verbatim', (_name, create) => {
    const declared = create().capabilities.menuPageSize;
    if (declared === undefined) return; // the conservative default; nothing to check
    // Round-tripping unchanged is the real assertion: a clamped value means the profile believes it
    // can carry a page core will never draw, which is exactly the disagreement this field exists to
    // prevent.
    expect(resolvePageSize(declared)).toBe(declared);
    expect(declared).toBeLessThanOrEqual(PAGE_SIZE_MAX);
  });

  it.each(PROFILES)('%s only declares one if it can actually carry a menu', (_name, create) => {
    const caps = create().capabilities;
    if (caps.menuPageSize === undefined) return;
    // workdirMenuSurface / modelMenuSurface require BOTH: a menu that can be posted but never
    // edited can never be paged, so a page size there would be describing something that is never
    // drawn.
    expect(caps.buttons).toBe(true);
    expect(caps.editButtons).toBe(true);
  });

  it('gives the same page to every platform that raised it above the default', () => {
    const raised = PROFILES.map(([, create]) => create().capabilities.menuPageSize).filter(
      (size): size is number => size !== undefined
    );
    expect(raised.length).toBeGreaterThan(0);
    // One shape for one menu: which chat app someone reads from should not change how many
    // directories they see. A platform that genuinely cannot carry the shared number is why the
    // field is per-profile — but then this test should be told about it deliberately.
    expect(new Set(raised).size).toBe(1);
    expect(raised[0]).toBeGreaterThan(PAGE_SIZE);
  });
});
