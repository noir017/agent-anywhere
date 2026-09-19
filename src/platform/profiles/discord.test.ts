import { describe, it, expect } from 'vitest';
import { specsToUniversalCommands, createDiscordProfile } from './discord.js';

// ── Fake bot for delivery-contract tests ──────────────────────────────────────
// Mirrors the telegram.test.ts approach: a pure-output unit test on the converter is not
// enough (a prior streaming bug slipped past pure tests), so we also assert what actually
// reaches Discord's API. The Discord profile sends RAW text via internal.createMessage /
// internal.editMessage — this fake captures those `{ content }` payloads and verifies the
// table → bullets rewrite is applied on BOTH send and edit, while other markdown is untouched.

type Profile = ReturnType<typeof createDiscordProfile>;
type SendBot = Parameters<NonNullable<Profile['sendMessage']>>[0];

/** One Discord action row, as the profile hand-builds it. */
interface Row {
  type: number;
  components: Array<{ type: number; style: number; label: string; custom_id: string }>;
}

interface Captured {
  create: Array<{ channelId: string; content: string; components?: Row[] }>;
  edit: Array<{ channelId: string; messageId: string; content: string; components?: Row[] }>;
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { create: [], edit: [] };
  const internal = {
    createMessage: (channelId: string, params: { content: string; components?: Row[] }) => {
      calls.create.push({ channelId, content: params.content, components: params.components });
      return Promise.resolve({ id: 'm1' });
    },
    editMessage: (
      channelId: string,
      messageId: string,
      params: { content: string; components?: Row[] }
    ) => {
      calls.edit.push({
        channelId,
        messageId,
        content: params.content,
        components: params.components,
      });
      return Promise.resolve({});
    },
  };
  const bot = { internal } as unknown as SendBot;
  return { bot, calls };
}

describe('discord profile delivery contract (table → bullets on send/edit, rest untouched)', () => {
  const profile = createDiscordProfile();
  const TABLE = '| Name | Score |\n|------|-------|\n| Ada | 95 |';

  it('sendMessage bulletizes a GFM table before the raw createMessage call', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: '123' }, TABLE);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.content).toBe('**Ada**\n• Score: 95');
    expect(ref).toEqual({ address: { channel: '123' }, messageId: 'm1' });
  });

  it('editMessage bulletizes a GFM table before the raw editMessage call', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(bot, { address: { channel: '123' }, messageId: '7' }, TABLE);
    expect(calls.edit).toHaveLength(1);
    // The fake records the raw internal.editMessage args, hence channelId (not an address).
    expect(calls.edit[0]).toMatchObject({
      channelId: '123',
      messageId: '7',
      content: '**Ada**\n• Score: 95',
    });
  });

  it('leaves non-table markdown byte-identical on send (Discord renders it natively)', async () => {
    const { bot, calls } = fakeBot();
    const md = '# Title\n\n**bold**, *italic*, `code`, [link](https://x.com)\n```js\nconst x = 1 | 2;\n```';
    await profile.sendMessage!(bot, { channel: '1' }, md);
    expect(calls.create[0]!.content).toBe(md);
  });

  it('leaves non-table markdown byte-identical on edit', async () => {
    const { bot, calls } = fakeBot();
    const md = '- a\n- b | c\n> quote';
    await profile.editMessage!(bot, { address: { channel: '1' }, messageId: '1' }, md);
    expect(calls.edit[0]!.content).toBe(md);
  });

  it('send and edit produce identical content for the same input (no streaming flicker)', async () => {
    const md = 'intro\n\n' + TABLE + '\n\noutro **bold**';
    const a = fakeBot();
    const b = fakeBot();
    await profile.sendMessage!(a.bot, { channel: '1' }, md);
    await profile.editMessage!(b.bot, { address: { channel: '1' }, messageId: '1' }, md);
    expect(a.calls.create[0]!.content).toBe(b.calls.edit[0]!.content);
  });
});

describe('specsToUniversalCommands', () => {
  it('parameterless command: maps to empty arguments/options/children + default-locale description', () => {
    const out = specsToUniversalCommands([{ name: 'help', description: 'Show help' }]);
    expect(out).toEqual([
      {
        name: 'help',
        description: { '': 'Show help' },
        arguments: [],
        options: [],
        children: [],
      },
    ]);
  });

  it('command with parameters: options map to Universal.Command.options, type defaults to string and required defaults to false', () => {
    const out = specsToUniversalCommands([
      {
        name: 'model',
        description: 'Switch model',
        options: [
          { name: 'name', description: 'Model name', type: 'string', required: true },
          { name: 'temp', description: 'Temperature' },
        ],
      },
    ]);
    expect(out[0]?.arguments).toEqual([]);
    expect(out[0]?.children).toEqual([]);
    expect(out[0]?.options).toEqual([
      { name: 'name', description: { '': 'Model name' }, type: 'string', required: true },
      { name: 'temp', description: { '': 'Temperature' }, type: 'string', required: false },
    ]);
  });

  it('multiple commands: mapped one by one', () => {
    const out = specsToUniversalCommands([
      { name: 'help', description: 'h' },
      { name: 'reset', description: 'r' },
    ]);
    expect(out.map((c) => c.name)).toEqual(['help', 'reset']);
  });
});

/**
 * Buttons on the raw API path.
 *
 * `sendButtons` used to go through `sendForRef` → the Satori encoder, which backslash-escapes
 * | * _ ` ~ ( ) [ ] — invisible while every menu button was a `/command` name, but a model menu
 * labels one "(nvidia) GLM-5.1". Worse, `editButtons` has to use the raw API (only
 * Message.EditParams carries `components`), so the two paths would have rendered the same text
 * differently and a page turn would visibly change the escaping. Both go raw now; these tests pin
 * that, and pin that an empty list is sent as an empty array — omitting the key LEAVES the buttons.
 */
describe('discord buttons (raw API, shared components builder)', () => {
  const profile = createDiscordProfile();
  const BTNS = [
    { id: 'mdl:ab12cd34:0', label: '(nvidia) GLM-5.1' },
    { id: 'mdl:ab12cd34:1', label: 'DeepSeek-V4-Pro', style: 'secondary' as const },
  ];

  it('declares the capability its editButtons implements', () => {
    expect(profile.capabilities.editButtons).toBe(true);
  });

  it('sendButtons posts content + action rows through internal.createMessage, unescaped', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendButtons!(bot, { channel: '123' }, 'Model: **x**', BTNS);
    expect(calls.create).toHaveLength(1);
    // No backslashes: the parenthesised provider prefix survives verbatim.
    expect(calls.create[0]!.content).toBe('Model: **x**');
    expect(calls.create[0]!.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: '(nvidia) GLM-5.1', custom_id: 'mdl:ab12cd34:0' },
          { type: 2, style: 2, label: 'DeepSeek-V4-Pro', custom_id: 'mdl:ab12cd34:1' },
        ],
      },
    ]);
    expect(ref).toEqual({ address: { channel: '123' }, messageId: 'm1' });
  });

  it('editButtons replaces text and buttons on the same message', async () => {
    const { bot, calls } = fakeBot();
    await profile.editButtons!(bot, { address: { channel: '123' }, messageId: '7' }, 'page 2', BTNS);
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0]!.channelId).toBe('123');
    expect(calls.edit[0]!.messageId).toBe('7');
    expect(calls.edit[0]!.content).toBe('page 2');
    expect(calls.edit[0]!.components![0]!.components).toHaveLength(2);
  });

  it('sends an EMPTY components array to clear buttons, never an absent key', async () => {
    const { bot, calls } = fakeBot();
    await profile.editButtons!(bot, { address: { channel: '1' }, messageId: '2' }, 'done', []);
    expect(calls.edit[0]!.components).toEqual([]);
  });

  it('chunks past five buttons into further rows (Discord allows 5 per row)', async () => {
    const { bot, calls } = fakeBot();
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: `L${i}` }));
    await profile.sendButtons!(bot, { channel: '1' }, 't', many);
    const rows = calls.create[0]!.components!;
    expect(rows.map((r) => r.components.length)).toEqual([5, 2]);
  });
});
