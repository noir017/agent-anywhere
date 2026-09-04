import { describe, expect, it } from 'vitest';
import {
  MODEL_PAGE_SIZE,
  buildModelMenu,
  matchModels,
  modelAmbiguousText,
  modelChoiceText,
  modelIndexOf,
  modelMenuSurface,
  modelPageCount,
  modelPageOf,
  modelSummaryText,
  parseModelButtonId,
  type ModelOption,
} from './model-menu.js';

/** The deployment's real shape: 6 opencode zen entries then 12 newapi ones, 18 in all. */
const OPTIONS: ModelOption[] = [
  { value: 'opencode/big-pickle', name: 'Big Pickle' },
  { value: 'opencode/hy3-free', name: 'HY3 (free)' },
  { value: 'opencode/mimo-v2.5-free', name: 'MiMo v2.5 (free)' },
  { value: 'opencode/muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2' },
  { value: 'opencode/nemotron-3-ultra-free', name: 'Nemotron 3 Ultra' },
  { value: 'opencode/nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning' },
  { value: 'newapi/deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { value: 'newapi/elysiver-deepseek-v4-flash-0731', name: '(elysiver) DeepSeek-V4-Flash-0731' },
  { value: 'newapi/glm-4.7-flash', name: 'GLM-4.7-Flash' },
  { value: 'newapi/glm-5.1-nvidia', name: '(nvidia) GLM-5.1' },
  { value: 'newapi/glm-5.1-nvidia-3682', name: '(nvidia) GLM-5.1-3682' },
  { value: 'newapi/GLM-5.2', name: 'GLM-5.2' },
  { value: 'newapi/GLM-5.2-3682', name: 'GLM-5.2-3682' },
  { value: 'newapi/nvidia-deepseek-v4-flash', name: '(nvidia) DeepSeek-V4-Flash' },
  { value: 'newapi/nvidia-deepseek-v4-flash-0731', name: '(nvidia) DeepSeek-V4-Flash-0731' },
  { value: 'newapi/sensenova-deepseek-v4-flash', name: '(sensenova) DeepSeek-V4-Flash' },
  { value: 'newapi/sensenova-glm-5.2', name: '(sensenova) GLM-5.2' },
  { value: 'newapi/tokenrhythm-deepseek-v4-flash-0731', name: '(tokenrhythm) DeepSeek-V4-Flash-0731' },
];

const menu = (page: number, current?: string) =>
  buildModelMenu({ reqId: 'ab12cd34', options: OPTIONS, current, page });

/** Only the model buttons (the trailing two are page navigation). */
const picks = (buttons: Array<{ id: string; label: string }>) =>
  buttons.filter((b) => b.id.startsWith('mdl:'));
const navs = (buttons: Array<{ id: string; label: string }>) =>
  buttons.filter((b) => b.id.startsWith('mpg:'));

describe('page arithmetic', () => {
  it('counts pages, never fewer than one', () => {
    expect(modelPageCount(18)).toBe(3);
    expect(modelPageCount(MODEL_PAGE_SIZE)).toBe(1);
    expect(modelPageCount(MODEL_PAGE_SIZE + 1)).toBe(2);
    expect(modelPageCount(0)).toBe(1);
  });

  it('maps an index to its page', () => {
    expect(modelPageOf(0)).toBe(0);
    expect(modelPageOf(MODEL_PAGE_SIZE - 1)).toBe(0);
    expect(modelPageOf(MODEL_PAGE_SIZE)).toBe(1);
    expect(modelPageOf(17)).toBe(2);
  });

  it('locates the current model, and says -1 for one the harness does not list', () => {
    expect(modelIndexOf(OPTIONS, 'newapi/GLM-5.2')).toBe(11);
    // An allowlisted-but-unlisted model still reports a currentValue; the menu must not crash on it.
    expect(modelIndexOf(OPTIONS, 'newapi/not-offered')).toBe(-1);
    expect(modelIndexOf(OPTIONS, undefined)).toBe(-1);
  });
});

describe('buildModelMenu', () => {
  it('slices the requested page in list order', () => {
    expect(picks(menu(1).buttons).map((b) => b.label)).toEqual([
      'DeepSeek-V4-Pro',
      '(elysiver) DeepSeek-V4-Flash-0731',
      'GLM-4.7-Flash',
      '(nvidia) GLM-5.1',
      '(nvidia) GLM-5.1-3682',
      'GLM-5.2',
    ]);
  });

  it('marks exactly one button as current, and only on the page holding it', () => {
    const onIt = picks(menu(1, 'newapi/GLM-5.2').buttons).filter((b) => b.label.startsWith('●'));
    expect(onIt).toHaveLength(1);
    expect(onIt[0]!.label).toBe('● GLM-5.2');
    expect(picks(menu(0, 'newapi/GLM-5.2').buttons).some((b) => b.label.startsWith('●'))).toBe(false);
  });

  it('carries absolute indices, so a button means the same model on any page', () => {
    // Page 2's first button is index 12 of the whole list, not index 0 of the page — the property
    // that stops paging from ever re-pointing a button at a different model.
    expect(picks(menu(2).buttons)[0]!.id).toBe('mdl:ab12cd34:12');
  });

  it('names the current model, the total and the page, and repeats the typed shortcut', () => {
    const text = menu(1, 'newapi/GLM-5.2').text;
    expect(text).toContain('newapi/GLM-5.2');
    expect(text).toContain('18 available');
    expect(text).toContain('page 2/3');
    expect(text).toContain('/model <part of a name>');
  });

  it('navigation WRAPS instead of leaving a dead button at each end', () => {
    // A hidden ◀ would shift every other button between pages, and Telegram has no disabled state —
    // so both edges point somewhere real.
    const first = navs(menu(0).buttons);
    expect(first.map((b) => b.id)).toEqual(['mpg:ab12cd34:2', 'mpg:ab12cd34:1']);
    const last = navs(menu(2).buttons);
    expect(last.map((b) => b.id)).toEqual(['mpg:ab12cd34:1', 'mpg:ab12cd34:0']);
  });

  it('offers no navigation at all when everything fits on one page', () => {
    const view = buildModelMenu({ reqId: 'r', options: OPTIONS.slice(0, 3), current: undefined, page: 0 });
    expect(navs(view.buttons)).toHaveLength(0);
    expect(view.pageCount).toBe(1);
  });

  it('wraps an out-of-range or negative page rather than rendering nothing', () => {
    expect(menu(3).page).toBe(0);
    expect(menu(-1).page).toBe(2);
  });

  it('falls back to the id when two models share a display name', () => {
    // Two providers offering "GLM-5.2" would otherwise draw two identical buttons.
    const dupes: ModelOption[] = [
      { value: 'a/glm-5.2', name: 'GLM-5.2' },
      { value: 'b/glm-5.2', name: 'GLM-5.2' },
      { value: 'a/other', name: 'Other' },
    ];
    const view = buildModelMenu({ reqId: 'r', options: dupes, current: undefined, page: 0 });
    expect(view.buttons.map((b) => b.label)).toEqual(['a/glm-5.2', 'b/glm-5.2', 'Other']);
  });

  it('ellipsises a very long label without touching the id it carries', () => {
    const long: ModelOption[] = [{ value: 'p/x', name: 'M'.repeat(120) }];
    const view = buildModelMenu({ reqId: 'r', options: long, current: undefined, page: 0 });
    expect(view.buttons[0]!.label.length).toBeLessThanOrEqual(40);
    expect(view.buttons[0]!.label.endsWith('…')).toBe(true);
    expect(view.buttons[0]!.id).toBe('mdl:r:0');
  });

  it('never exceeds Discord\'s 25 components, nor Telegram\'s 64-byte callback_data', () => {
    // The two hard platform caps. The id budget is why an index, not a model name, rides in it:
    // Telegram hashes anything longer, lossily, and the click comes back unresolvable.
    const many: ModelOption[] = Array.from({ length: 400 }, (_, i) => ({
      value: `provider/model-${i}`,
      name: `Model ${i}`,
    }));
    for (const page of [0, 1, 66]) {
      const view = buildModelMenu({ reqId: 'ab12cd34', options: many, current: undefined, page });
      expect(view.buttons.length).toBeLessThanOrEqual(25);
      for (const b of view.buttons) expect(Buffer.byteLength(b.id, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('button ids', () => {
  it('round-trips both kinds and keeps them distinguishable', () => {
    const view = menu(1, 'newapi/GLM-5.2');
    expect(parseModelButtonId(picks(view.buttons)[0]!.id)).toEqual({
      kind: 'pick',
      reqId: 'ab12cd34',
      index: 6,
    });
    expect(parseModelButtonId(navs(view.buttons)[1]!.id)).toEqual({
      kind: 'page',
      reqId: 'ab12cd34',
      page: 2,
    });
  });

  it('ignores other menus\' ids and garbage', () => {
    expect(parseModelButtonId('ask:r1:0')).toBeNull();
    expect(parseModelButtonId('cmd:r1:0')).toBeNull();
    expect(parseModelButtonId('mdl:r1:x')).toBeNull();
    expect(parseModelButtonId('nonsense')).toBeNull();
  });
});

describe('modelMenuSurface', () => {
  it('needs BOTH buttons and editButtons — a menu that cannot be retired is worse than text', () => {
    expect(modelMenuSurface({ buttons: true, editButtons: true }, 18)).toBe('menu');
    expect(modelMenuSurface({ buttons: true, editButtons: false }, 18)).toBe('text');
    expect(modelMenuSurface({ buttons: false, editButtons: false }, 18)).toBe('text');
  });

  it('treats a capability object that omits the fields as the safe surface', () => {
    expect(modelMenuSurface({}, 18)).toBe('text');
  });

  it('does not open a menu whose only action is to re-pick what is already running', () => {
    expect(modelMenuSurface({ buttons: true, editButtons: true }, 1)).toBe('text');
    expect(modelMenuSurface({ buttons: true, editButtons: true }, 0)).toBe('text');
  });
});

describe('matchModels', () => {
  it('takes an exact id even when it is a substring of another', () => {
    // `newapi/GLM-5.2` is a substring of `newapi/GLM-5.2-3682`; typing it in full must not be
    // answered with an ambiguity prompt.
    expect(matchModels(OPTIONS, 'newapi/GLM-5.2')).toEqual({
      kind: 'one',
      option: { value: 'newapi/GLM-5.2', name: 'GLM-5.2' },
    });
  });

  it('matches a substring of either the id or the display name, case-insensitively', () => {
    expect(matchModels(OPTIONS, 'elysiver').kind).toBe('one');
    expect(matchModels(OPTIONS, 'GLM-4.7').kind).toBe('one');
  });

  it('lists candidates rather than guessing when a query is ambiguous', () => {
    const m = matchModels(OPTIONS, 'glm-5.1');
    expect(m.kind).toBe('many');
    if (m.kind === 'many') expect(m.matches).toHaveLength(2);
  });

  it('says nothing matched', () => {
    expect(matchModels(OPTIONS, 'gpt-9')).toEqual({ kind: 'none' });
  });

  it('caps a long ambiguity list and says how many were withheld', () => {
    const many: ModelOption[] = Array.from({ length: 20 }, (_, i) => ({
      value: `p/m-${i}`,
      name: `M ${i}`,
    }));
    const text = modelAmbiguousText('m', many);
    expect(text).toContain('matches 20 models');
    expect(text).toContain('…and 8 more');
  });
});

describe('the strings both surfaces share', () => {
  it('summarises without a menu the way it always has', () => {
    const text = modelSummaryText({ current: 'newapi/GLM-5.2', options: OPTIONS });
    expect(text).toContain('newapi/GLM-5.2');
    expect(text).toContain('18 available');
  });

  it('gives every choice outcome its own words, naming what to do next', () => {
    expect(modelChoiceText({ kind: 'applied', model: 'newapi/GLM-5.2' })).toContain('newapi/GLM-5.2');
    expect(modelChoiceText({ kind: 'unavailable' })).toContain('/model');
    expect(modelChoiceText({ kind: 'missing', value: 'newapi/gone' })).toContain('newapi/gone');
    expect(modelChoiceText({ kind: 'rebound', agent: 'claude' })).toContain('claude');
    expect(modelChoiceText({ kind: 'gone' })).toContain('gone');
    expect(modelChoiceText({ kind: 'failed', reason: 'harness said no' })).toContain('harness said no');
  });
});
