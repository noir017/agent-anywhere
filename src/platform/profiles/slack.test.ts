import { describe, it, expect } from 'vitest';
import { slackConversation, buildButtonBlocks, createSlackProfile } from './slack.js';

// ── Fake bot for delivery-contract tests ──────────────────────────────────────
// These tests capture what the profile ACTUALLY sends to Slack's Web API, not just what the
// converter returns. This matters because @satorijs/adapter-slack's MessageEncoder.escape()
// zero-width-spaces every `*`/`_`/`~` and rewrites `<...>` → `&lt;...&gt;` — so if the profile ever
// routed pre-rendered mrkdwn back through bot.sendMessage/bot.editMessage, our `*bold*` and
// `<url|text>` links would be mangled and a pure-converter unit test would never catch it (the
// Telegram <br/> lesson). The fake therefore guards bot.sendMessage/editMessage with a throw and
// only allows internal.chatPostMessage / internal.chatUpdate, asserting send AND edit deliver
// identical valid mrkdwn via the Bot OAuth token.

type Profile = ReturnType<typeof createSlackProfile>;
type SendBot = Parameters<NonNullable<Profile['sendMessage']>>[0];

interface Captured {
  post: Array<{ token: string; params: Record<string, unknown> }>;
  update: Array<{ token: string; params: Record<string, unknown> }>;
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { post: [], update: [] };
  const internal = {
    chatPostMessage: (token: string, params: Record<string, unknown>) => {
      calls.post.push({ token, params });
      return Promise.resolve({ channel: String(params.channel), ts: '111.222', ok: true });
    },
    chatUpdate: (token: string, params: Record<string, unknown>) => {
      calls.update.push({ token, params });
      return Promise.resolve({ ok: true });
    },
  };
  const guard = (): never => {
    throw new Error('profile must route send/edit through internal.chat*, not bot.*');
  };
  const bot = {
    internal,
    config: { botToken: 'xoxb-test' },
    sendMessage: guard,
    editMessage: guard,
  } as unknown as SendBot;
  return { bot, calls };
}

/**
 * Inbound thread detection — the asymmetry this refactor closed.
 *
 * Slack's adapter exposes no thread flag: it populates session.quote with the thread ROOT, and
 * only when `thread_ts !== ts` — so the quote is a reliable witness of "this is a thread reply",
 * and `quote.id` is the thread_ts itself. The profile used to give up there and hardcode "not a
 * thread", while its OUTBOUND side happily emitted thread addresses — so a reply typed inside a
 * thread was routed as ordinary channel traffic and answered in the channel.
 */
describe('slackConversation (inbound thread detection)', () => {
  it('reads the thread root out of session.quote (the only witness the adapter leaves)', () => {
    expect(
      slackConversation({ channelId: 'C0123ABCD', guildId: 'T1', quote: { id: '1700000000.0001' } })
    ).toEqual({
      channel: 'C0123ABCD',
      thread: '1700000000.0001',
      space: 'T1',
      kind: 'thread',
    });
  });

  it('reports a plain channel message with no lane', () => {
    expect(slackConversation({ channelId: 'C0123ABCD', guildId: 'T1' })).toEqual({
      channel: 'C0123ABCD',
      space: 'T1',
      kind: 'group',
    });
  });

  it('reports a DM as direct', () => {
    expect(slackConversation({ channelId: 'D9', isDirect: true })).toEqual({
      channel: 'D9',
      kind: 'direct',
    });
  });

  it('keeps two threads in one channel separate', () => {
    const a = slackConversation({ channelId: 'C1', quote: { id: '1.1' } });
    const b = slackConversation({ channelId: 'C1', quote: { id: '2.2' } });
    expect(a.channel).toBe(b.channel);
    expect(a.thread).not.toBe(b.thread);
  });

  it('an inbound thread message answers back INTO the thread (end-to-end of the fix)', async () => {
    const profile = createSlackProfile();
    const c = slackConversation({ channelId: 'C0123ABCD', quote: { id: '1700000000.0001' } });
    const { bot, calls } = fakeBot();
    await profile.sendMessage!(bot, { channel: c.channel, thread: c.thread }, 'reply');
    // Pre-fix this posted with no thread_ts at all, landing in the channel.
    expect(calls.post[0]!.params).toMatchObject({
      channel: 'C0123ABCD',
      thread_ts: '1700000000.0001',
    });
  });
});

describe('buildButtonBlocks', () => {
  it('produces both a section and an actions block when text is present', () => {
    const blocks = buildButtonBlocks('Pick one', [
      { id: 'ask:abc:0', label: 'Yes' },
      { id: 'ask:abc:1', label: 'No' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'section', text: { type: 'mrkdwn', text: 'Pick one' } });
    expect(blocks[1]).toMatchObject({ type: 'actions' });
  });

  it('produces only an actions block when text is empty', () => {
    const blocks = buildButtonBlocks('', [{ id: 'x', label: 'X' }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'actions' });
  });

  it('omits the actions block entirely when there are no buttons (Slack rejects an empty one)', () => {
    // Clearing a retired menu is exactly a zero-button call; an `actions` block with no elements
    // is invalid_blocks, so the block must be absent rather than empty.
    const blocks = buildButtonBlocks('Model set', []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'section' });
  });

  it('encodes id into both button.action_id and value (round-trip consistency)', () => {
    const blocks = buildButtonBlocks('', [{ id: 'ask:r:2', label: 'L' }]);
    const actions = blocks[0] as { elements: Array<Record<string, unknown>> };
    expect(actions.elements[0]).toMatchObject({
      type: 'button',
      action_id: 'ask:r:2',
      value: 'ask:r:2',
      text: { type: 'plain_text', text: 'L' },
    });
  });

  it('passes through only primary/danger as style, leaving others unset (avoids a Slack 400)', () => {
    const blocks = buildButtonBlocks('', [
      { id: 'a', label: 'A', style: 'primary' },
      { id: 'b', label: 'B', style: 'danger' },
      { id: 'c', label: 'C', style: 'secondary' },
      { id: 'd', label: 'D' },
    ]);
    const els = (blocks[0] as { elements: Array<Record<string, unknown>> }).elements;
    expect(els[0]!.style).toBe('primary');
    expect(els[1]!.style).toBe('danger');
    expect(els[2]!.style).toBeUndefined();
    expect(els[3]!.style).toBeUndefined();
  });
});

describe('slack profile delivery contract (send/edit reach Slack as valid mrkdwn)', () => {
  const profile = createSlackProfile();

  it('sendMessage posts rendered mrkdwn via internal.chatPostMessage with the bot token', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'C0123ABCD' }, '**hi** [x](https://x.com/a)');
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0]!.token).toBe('xoxb-test');
    expect(calls.post[0]!.params).toMatchObject({
      channel: 'C0123ABCD',
      text: '*hi* <https://x.com/a|x>',
    });
    expect(calls.post[0]!.params.thread_ts).toBeUndefined();
    expect(ref).toEqual({ address: { channel: 'C0123ABCD' }, messageId: '111.222' });
  });

  it('an address with a lane routes thread_ts', async () => {
    const { bot, calls } = fakeBot();
    const address = { channel: 'C0123ABCD', thread: '1700000000.0001' };
    const ref = await profile.sendMessage!(bot, address, 'plain');
    expect(calls.post[0]!.params).toMatchObject({
      channel: 'C0123ABCD',
      thread_ts: '1700000000.0001',
      text: 'plain',
    });
    expect(ref).toEqual({ address, messageId: '111.222' });
  });

  it('editMessage posts rendered mrkdwn via internal.chatUpdate (never bot.editMessage)', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(bot, { address: { channel: 'C0123ABCD' }, messageId: '7.7' }, '# Title\n- a');
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]!.token).toBe('xoxb-test');
    expect(calls.update[0]!.params).toMatchObject({
      channel: 'C0123ABCD',
      ts: '7.7',
      text: '*Title*\n• a',
    });
  });

  it('send and edit render byte-identical mrkdwn for the same input (no streaming flicker)', async () => {
    const md = '**bold**\n- a\n- b\n```js\nconst x = 1;\n```\n> quote\n[l](https://x.com/a)';
    const a = fakeBot();
    const b = fakeBot();
    await profile.sendMessage!(a.bot, { channel: 'C1' }, md);
    await profile.editMessage!(b.bot, { address: { channel: 'C1' }, messageId: '1.1' }, md);
    expect(a.calls.post[0]!.params.text).toBe(b.calls.update[0]!.params.text);
  });

  it('reply posts into the thread (thread_ts = ref.messageId) with rendered mrkdwn', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.reply!(
      bot,
      { address: { channel: 'C0123ABCD' }, messageId: '5.5' },
      '*emph*'
    );
    expect(calls.post[0]!.params).toMatchObject({
      channel: 'C0123ABCD',
      thread_ts: '5.5',
      text: '_emph_',
    });
    // The reply lives in the thread it just started, so the ref carries that lane — a follow-up
    // on this message must not escape back to the channel.
    expect(ref).toEqual({
      address: { channel: 'C0123ABCD', thread: '5.5' },
      messageId: '111.222',
    });
  });

  it('sendButtons renders the section text to mrkdwn (mrkdwn section block must convert)', async () => {
    const { bot, calls } = fakeBot();
    await profile.sendButtons!(bot, { channel: 'C0123ABCD' }, 'Pick **one**', [
      { id: 'ask:r:0', label: 'Yes' },
    ]);
    const params = calls.post[0]!.params;
    expect(params.text).toBe('Pick *one*');
    const blocks = params.blocks as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ type: 'section', text: { type: 'mrkdwn', text: 'Pick *one*' } });
  });

  it('editButtons updates the same message through chat.update with the new blocks', async () => {
    // The page-turn primitive: chat.update takes the same `blocks` payload chatPostMessage does,
    // so a menu advances in place. No thread parameter — channel + ts locate a message wherever it
    // lives — and the guard in fakeBot fails the test if the profile falls back to bot.editMessage.
    const { bot, calls } = fakeBot();
    await profile.editButtons!(
      bot,
      { address: { channel: 'C0123ABCD', thread: '5.5' }, messageId: '111.222' },
      'Model: **x**',
      [{ id: 'mdp:r1:2', label: '▶' }]
    );
    expect(calls.post).toHaveLength(0); // never a fresh post
    expect(calls.update).toHaveLength(1);
    const { token, params } = calls.update[0]!;
    expect(token).toBe('xoxb-test');
    expect(params).toMatchObject({ channel: 'C0123ABCD', ts: '111.222', text: 'Model: *x*' });
    expect(params.thread_ts).toBeUndefined();
    const blocks = params.blocks as Array<Record<string, unknown>>;
    expect(blocks[1]).toMatchObject({ type: 'actions' });
  });

  it('createThread from inside a thread targets the real channel, never a doubled key', async () => {
    // Slack has no create-thread API: a thread is "use a message ts as thread_ts". The old code
    // had to decode ref.channelId to avoid concatenating onto an already-composite key; with the
    // lane in its own field the channel is always the channel.
    const out = await profile.createThread!(
      fakeBot().bot,
      { address: { channel: 'C0123ABCD', thread: '1.1' }, messageId: '9.9' },
      'debug'
    );
    expect(out).toEqual({ address: { channel: 'C0123ABCD', thread: '9.9' } });
  });

  it('never delivers a literal CommonMark bold marker (the asterisk bug this fixes)', async () => {
    const { bot, calls } = fakeBot();
    await profile.sendMessage!(bot, { channel: 'C1' }, 'this is **important**');
    const text = String(calls.post[0]!.params.text);
    expect(text).not.toContain('**'); // would have shown literal asterisks pre-fix
    expect(text).toBe('this is *important*');
  });
});
