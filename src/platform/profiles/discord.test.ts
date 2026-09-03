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

interface Captured {
  create: Array<{ channelId: string; content: string }>;
  edit: Array<{ channelId: string; messageId: string; content: string }>;
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { create: [], edit: [] };
  const internal = {
    createMessage: (channelId: string, params: { content: string }) => {
      calls.create.push({ channelId, content: params.content });
      return Promise.resolve({ id: 'm1' });
    },
    editMessage: (channelId: string, messageId: string, params: { content: string }) => {
      calls.edit.push({ channelId, messageId, content: params.content });
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
