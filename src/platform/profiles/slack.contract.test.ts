// Slack frame parse+normalize contract test.
//
// Background (see slack.ts header Hyrum's Law warning): interactive (block_actions) / slash_commands
// receiving relies on undocumented internals of @satorijs/adapter-slack and @satorijs/core, with no
// CI coverage. This pins the pure "raw frame -> normalized" logic with realistic fake frames. If
// frame shapes change on a dep upgrade, this goes red first -- prompting manual regression of the socket path.
import { describe, it, expect } from 'vitest';
import {
  parseSlackInteractiveFrame,
  parseSlackSlashFrame,
  toSlackReactionName,
} from './slack.js';

describe('toSlackReactionName', () => {
  // Slack reactions.add/remove name accepts only shortnames (no colons/unicode) -- see slack.ts addReaction.
  it("maps daemon's default unicode lifecycle emoji to Slack shortnames", () => {
    expect(toSlackReactionName('👀')).toBe('eyes');
    expect(toSlackReactionName('✅')).toBe('white_check_mark');
    expect(toSlackReactionName('❌')).toBe('x');
  });

  it('strips surrounding colons from a colon-wrapped shortname', () => {
    expect(toSlackReactionName(':eyes:')).toBe('eyes');
    expect(toSlackReactionName(':white_check_mark:')).toBe('white_check_mark');
  });

  it('passes through a bare shortname unchanged', () => {
    expect(toSlackReactionName('eyes')).toBe('eyes');
    expect(toSlackReactionName('thumbsup')).toBe('thumbsup');
  });

  it('passes through unknown unicode unchanged (lets Slack decide)', () => {
    expect(toSlackReactionName('🦄')).toBe('🦄');
  });
});

describe('parseSlackInteractiveFrame', () => {
  it('block_actions frame: action_id -> buttonId, normalizes user/channel/message', () => {
    const raw = JSON.stringify({
      type: 'interactive',
      envelope_id: 'env-1',
      payload: {
        type: 'block_actions',
        user: { id: 'U123' },
        channel: { id: 'C456' },
        message: { ts: '1700000000.000100' },
        actions: [{ action_id: 'ask:r:0', value: 'ask:r:0' }],
      },
    });
    expect(parseSlackInteractiveFrame(raw)).toEqual([
      {
        // Slack sends no thread_ts with an interactive frame, so the click is honestly reported
        // as belonging to the channel rather than guessed into a thread.
        conversation: { channel: 'C456', kind: 'group' },
        user: 'U123',
        messageId: '1700000000.000100',
        buttonId: 'ask:r:0',
      },
    ]);
  });

  it('multiple actions: one entry each, skipping any missing action_id', () => {
    const raw = JSON.stringify({
      type: 'interactive',
      payload: {
        type: 'block_actions',
        user: { id: 'U1' },
        channel: { id: 'C1' },
        message: { ts: '1.1' },
        actions: [{ action_id: 'a' }, { value: 'no action_id' }, { action_id: 'b' }],
      },
    });
    const out = parseSlackInteractiveFrame(raw);
    expect(out?.map((e) => e.buttonId)).toEqual(['a', 'b']);
  });

  it('normalizes missing user/channel/message to empty strings (does not throw)', () => {
    const raw = JSON.stringify({
      type: 'interactive',
      payload: { type: 'block_actions', actions: [{ action_id: 'x' }] },
    });
    expect(parseSlackInteractiveFrame(raw)).toEqual([
      { conversation: { channel: '', kind: 'group' }, user: '', messageId: '', buttonId: 'x' },
    ]);
  });

  it('payload.type other than block_actions (e.g. view_submission) -> null', () => {
    const raw = JSON.stringify({
      type: 'interactive',
      payload: { type: 'view_submission' },
    });
    expect(parseSlackInteractiveFrame(raw)).toBeNull();
  });

  it('unrelated frames (events_api / hello) -> null', () => {
    expect(parseSlackInteractiveFrame(JSON.stringify({ type: 'events_api' }))).toBeNull();
    expect(parseSlackInteractiveFrame(JSON.stringify({ type: 'hello' }))).toBeNull();
  });

  it('malformed JSON -> null (does not throw)', () => {
    expect(parseSlackInteractiveFrame('{ not json')).toBeNull();
  });

  it('block_actions but actions missing -> empty array (not null; means "right type but nothing to emit")', () => {
    const raw = JSON.stringify({ type: 'interactive', payload: { type: 'block_actions' } });
    expect(parseSlackInteractiveFrame(raw)).toEqual([]);
  });
});

describe('parseSlackSlashFrame', () => {
  it('slash frame: command strips leading /, text splits into raw + arg0.. + name (=arg0)', () => {
    const raw = JSON.stringify({
      type: 'slash_commands',
      envelope_id: 'env-2',
      payload: {
        command: '/model',
        text: 'gpt-x extra',
        channel_id: 'C9',
        user_id: 'U9',
        response_url: 'https://hooks.slack.com/x',
      },
    });
    expect(parseSlackSlashFrame(raw)).toEqual({
      name: 'model',
      channelId: 'C9',
      userId: 'U9',
      options: {
        raw: 'gpt-x extra',
        arg0: 'gpt-x',
        arg1: 'extra',
        name: 'gpt-x', // arg0 maps to name (so /model <name> hits)
      },
    });
  });

  it('parameterless slash: options contains only an empty raw, no argN/name', () => {
    const raw = JSON.stringify({
      type: 'slash_commands',
      payload: { command: '/help', text: '', channel_id: 'C1', user_id: 'U1' },
    });
    expect(parseSlackSlashFrame(raw)).toEqual({
      name: 'help',
      channelId: 'C1',
      userId: 'U1',
      options: { raw: '' },
    });
  });

  it('text with extra whitespace: trim + split on whitespace (consecutive whitespace produces no empty arg)', () => {
    const raw = JSON.stringify({
      type: 'slash_commands',
      payload: { command: '/x', text: '  a   b  ' },
    });
    const parsed = parseSlackSlashFrame(raw);
    expect(parsed?.options).toEqual({ raw: 'a   b', arg0: 'a', arg1: 'b', name: 'a' });
    expect(parsed?.channelId).toBe(''); // missing channel_id -> empty string
  });

  it('no command -> null', () => {
    const raw = JSON.stringify({ type: 'slash_commands', payload: { text: 'x' } });
    expect(parseSlackSlashFrame(raw)).toBeNull();
  });

  it('non-slash_commands frame -> null', () => {
    expect(
      parseSlackSlashFrame(JSON.stringify({ type: 'interactive', payload: {} }))
    ).toBeNull();
  });

  it('malformed JSON -> null (does not throw)', () => {
    expect(parseSlackSlashFrame('not-json')).toBeNull();
  });
});
