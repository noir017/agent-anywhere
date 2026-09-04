import { describe, it, expect } from 'vitest';
import { MessageNotEditableError } from '../../core/outbound-errors.js';
import {
  mapLarkEmojiType,
  mapLarkButtonType,
  buildLarkButtonCard,
  extractCardAction,
  larkReceiveIdType,
  rememberBounded,
  createLarkProfile,
  parseLarkResourceUrl,
  sniffLarkMedia,
  extractResourceNames,
  larkPostElements,
} from './lark.js';

// ── Fake bot for delivery-contract tests ──────────────────────────────────────
// Like the Telegram suite, these guard the SEND-vs-EDIT consistency that pure
// converter tests miss: the bug class is "send and edit render the agent's
// markdown differently" (flicker / format drift on streaming edits). The Lark
// profile's sendMessage/editMessage overrides pre-render CommonMark to the Feishu
// markdown subset, then hand the STRING to the adapter (bot.sendMessage →
// post create, bot.editMessage → im.message.update). This fake captures exactly
// the (channelId/messageId, content) the profile passes to bot.* so we can assert
// the converted content reaches the wire identically on both paths.
type Profile = ReturnType<typeof createLarkProfile>;
type SendBot = Parameters<NonNullable<Profile['sendMessage']>>[0];

interface Captured {
  send: Array<{ channelId: string; content: string }>;
  edit: Array<{ channelId: string; messageId: string; content: string }>;
}

function fakeBot(): { bot: SendBot; calls: Captured } {
  const calls: Captured = { send: [], edit: [] };
  const bot = {
    sendMessage: (channelId: string, content: string) => {
      calls.send.push({ channelId, content });
      return Promise.resolve(['om_42']);
    },
    editMessage: (channelId: string, messageId: string, content: string) => {
      calls.edit.push({ channelId, messageId, content });
      return Promise.resolve();
    },
  } as unknown as SendBot;
  return { bot, calls };
}

/**
 * Bot whose `internal.im.message` is captured — the card path never goes through bot.sendMessage /
 * bot.editMessage (the satori encoder would re-encode a card as a post and drop the button ids).
 */
function fakeCardBot(): {
  bot: SendBot;
  calls: { patch: Array<{ messageId: string; content: string }> };
} {
  const calls = { patch: [] as Array<{ messageId: string; content: string }> };
  const guard = (): never => {
    throw new Error('the card path must use internal.im.message.*, not bot.*');
  };
  const bot = {
    internal: {
      im: {
        message: {
          patch: (messageId: string, body: { content: string }) => {
            calls.patch.push({ messageId, content: body.content });
            return Promise.resolve();
          },
        },
      },
    },
    sendMessage: guard,
    editMessage: guard,
  } as unknown as SendBot;
  return { bot, calls };
}

describe('mapLarkEmojiType', () => {
  it('maps lifecycle unicode to Lark emoji_type enum values', () => {
    expect(mapLarkEmojiType('👀')).toBe('GLANCE');
    expect(mapLarkEmojiType('✅')).toBe('DONE');
    expect(mapLarkEmojiType('❌')).toBe('CrossMark');
  });

  it('also maps common unicode emoji', () => {
    expect(mapLarkEmojiType('👍')).toBe('THUMBSUP');
    expect(mapLarkEmojiType('🎉')).toBe('PARTY');
  });

  it('matches Lark official enum casing char-by-char (mixed case, not guessable)', () => {
    expect(mapLarkEmojiType('❤️')).toBe('HEART');
    expect(mapLarkEmojiType('🙏')).toBe('THANKS');
    expect(mapLarkEmojiType('👎')).toBe('ThumbsDown');
    expect(mapLarkEmojiType('🔥')).toBe('Fire');
    expect(mapLarkEmojiType('🎉')).toBe('PARTY'); // Lark has no CELEBRATE
    expect(mapLarkEmojiType('👌')).toBe('OK');
  });

  it('returns undefined for unmapped emoji (upper layer safely skips)', () => {
    expect(mapLarkEmojiType('🤷')).toBeUndefined();
    expect(mapLarkEmojiType('')).toBeUndefined();
  });
});

describe('mapLarkButtonType', () => {
  it('passes through valid Lark types; unknown/missing falls back to default', () => {
    expect(mapLarkButtonType('primary')).toBe('primary');
    expect(mapLarkButtonType('danger')).toBe('danger');
    expect(mapLarkButtonType('default')).toBe('default');
    expect(mapLarkButtonType('text')).toBe('text');
    expect(mapLarkButtonType('secondary')).toBe('default'); // not a Lark enum
    expect(mapLarkButtonType(undefined)).toBe('default'); // missing
  });
});

describe('buildLarkButtonCard', () => {
  it('builds a schema 2.0 card: text + each button encodes id into behaviors[].value', () => {
    const card = buildLarkButtonCard('Please choose:', [
      { id: 'ask:abc:0', label: 'Yes' },
      { id: 'ask:abc:1', label: 'No', style: 'danger' },
    ]) as {
      schema: string;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.schema).toBe('2.0');
    const els = card.body.elements;
    // First element is the text markdown.
    expect(els[0]).toMatchObject({ tag: 'markdown', content: 'Please choose:' });
    // Then two buttons; value.id must be the verbatim button.id (matches daemon pendingAsks).
    const b0 = els[1] as {
      tag: string;
      type: string;
      behaviors: Array<{ type: string; value: { id: string } }>;
    };
    expect(b0.tag).toBe('button');
    expect(b0.type).toBe('default'); // missing style → default (Lark safe default)
    expect(b0.behaviors[0]).toEqual({ type: 'callback', value: { id: 'ask:abc:0' } });
    const b1 = els[2] as { type: string; behaviors: Array<{ value: { id: string } }> };
    expect(b1.type).toBe('danger'); // explicit style passes through
    expect(b1.behaviors[0]!.value.id).toBe('ask:abc:1');
  });

  it('produces no text element when text is empty, only buttons', () => {
    const card = buildLarkButtonCard('', [{ id: 'x', label: 'OK' }]) as {
      body: { elements: Array<{ tag: string }> };
    };
    expect(card.body.elements).toHaveLength(1);
    expect(card.body.elements[0]!.tag).toBe('button');
  });
});

describe('extractCardAction', () => {
  const baseBody = {
    type: 'card.action.trigger',
    event: {
      action: { value: { id: 'ask:abc:1' } },
      context: { open_message_id: 'om_123', open_chat_id: 'oc_456' },
      operator: { open_id: 'ou_789' },
    },
  };

  it('recovers value.id / messageId / channelId / userId from card.action.trigger', () => {
    expect(extractCardAction(baseBody)).toEqual({
      id: 'ask:abc:1',
      channelId: 'oc_456',
      messageId: 'om_123',
      userId: 'ou_789',
    });
  });

  it('recovers id even when value is a JSON string', () => {
    const body = {
      ...baseBody,
      event: { ...baseBody.event, action: { value: JSON.stringify({ id: 'ask:zzz:0' }) } },
    };
    expect(extractCardAction(body)?.id).toBe('ask:zzz:0');
  });

  it('non-card event / missing id ⇒ null (ignored)', () => {
    expect(extractCardAction({ type: 'im.message.receive_v1' })).toBeNull();
    expect(
      extractCardAction({ type: 'card.action.trigger', event: { action: { value: {} } } })
    ).toBeNull();
    expect(extractCardAction(undefined)).toBeNull();
    expect(extractCardAction(null)).toBeNull();
  });
});

describe('larkReceiveIdType', () => {
  it('infers receive_id_type from id prefix/shape', () => {
    expect(larkReceiveIdType('ou_abc')).toBe('open_id');
    expect(larkReceiveIdType('on_abc')).toBe('union_id');
    expect(larkReceiveIdType('oc_abc')).toBe('chat_id');
    expect(larkReceiveIdType('a@b.com')).toBe('email');
    expect(larkReceiveIdType('plainuser')).toBe('user_id');
  });
});

describe('rememberBounded', () => {
  it('evicts the least recently touched entry once past the limit', () => {
    const m = new Map<string, number>();
    rememberBounded(m, 'a', 1, 2);
    rememberBounded(m, 'b', 2, 2);
    rememberBounded(m, 'c', 3, 2);
    expect([...m.keys()]).toEqual(['b', 'c']);
  });

  it('a rewrite counts as recent, so it is not the next eviction', () => {
    const m = new Map<string, number>();
    rememberBounded(m, 'a', 1, 2);
    rememberBounded(m, 'b', 2, 2);
    rememberBounded(m, 'a', 9, 2); // refreshes 'a', making 'b' oldest
    rememberBounded(m, 'c', 3, 2);
    expect([...m.entries()]).toEqual([
      ['a', 9],
      ['c', 3],
    ]);
  });
});

describe('buildLarkButtonCard converts text to the Feishu markdown subset', () => {
  it('degrades a GFM table in the card markdown content into bullets', () => {
    const card = buildLarkButtonCard('| Name | Score |\n|---|---|\n| Ada | 95 |', [
      { id: 'x', label: 'OK' },
    ]) as { body: { elements: Array<{ tag: string; content?: string }> } };
    expect(card.body.elements[0]).toMatchObject({
      tag: 'markdown',
      content: '**Ada**\n• Score: 95',
    });
  });

  it('leaves plain card text unchanged (no false rewrites)', () => {
    const card = buildLarkButtonCard('Please choose:', [{ id: 'x', label: 'OK' }]) as {
      body: { elements: Array<{ content?: string }> };
    };
    expect(card.body.elements[0]!.content).toBe('Please choose:');
  });
});

describe('lark profile delivery contract (send/edit reach Lark as converted markdown)', () => {
  const profile = createLarkProfile();

  it('sendMessage passes converted markdown to bot.sendMessage and returns the first id', async () => {
    const { bot, calls } = fakeBot();
    const ref = await profile.sendMessage!(bot, { channel: 'oc_1' }, '# Title\nhello');
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toEqual({ channelId: 'oc_1', content: '**Title**\nhello' });
    expect(ref).toEqual({ address: { channel: 'oc_1' }, messageId: 'om_42' });
  });

  it('editMessage passes converted markdown to bot.editMessage', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(bot, { address: { channel: 'oc_1' }, messageId: 'om_7' }, '## Sub');
    expect(calls.edit).toHaveLength(1);
    // The fake records the raw bot.editMessage args, hence channelId (not an address).
    expect(calls.edit[0]).toEqual({ channelId: 'oc_1', messageId: 'om_7', content: '**Sub**' });
  });

  it('regression: a GFM table is degraded to bullets on the wire (no raw pipe table)', async () => {
    const { bot, calls } = fakeBot();
    await profile.editMessage!(
      bot,
      { address: { channel: 'oc_1' }, messageId: 'om_1' },
      'intro\n\n| Name | Score |\n|------|-------|\n| Ada | 95 |'
    );
    const content = calls.edit[0]!.content;
    expect(content).not.toMatch(/\|\s*-{2,}/); // separator row gone
    expect(content).toContain('**Ada**');
    expect(content).toContain('• Score: 95');
  });

  it('send and edit render byte-identical content for the same input (no streaming flicker)', async () => {
    const md = '**bold**\n- a\n- b\n# Heading\n| K | V |\n|---|---|\n| a | 1 |';
    const a = fakeBot();
    const b = fakeBot();
    await profile.sendMessage!(a.bot, { channel: 'oc_1' }, md);
    await profile.editMessage!(b.bot, { address: { channel: 'oc_1' }, messageId: 'om_1' }, md);
    expect(a.calls.send[0]!.content).toBe(b.calls.edit[0]!.content);
  });
});

/**
 * The per-message edit cap is the one Lark failure the streaming writers MUST tell apart from a
 * rate limit: once 230072 comes back, that message is done forever, so the writer has to seal it
 * and continue in a new one. Reported as a transient failure instead, it produced the truncated
 * reply this classification exists to prevent.
 */
describe('lark edit-limit classification (230072 → MessageNotEditableError)', () => {
  const profile = createLarkProfile();

  /** Bot whose editMessage throws `err`. */
  function throwingBot(err: unknown): SendBot {
    return {
      sendMessage: () => Promise.resolve(['om_1']),
      editMessage: () => Promise.reject(err),
    } as unknown as SendBot;
  }

  const ref = { address: { channel: 'oc_1' }, messageId: 'om_1' };

  it('declares the cap as a capability so writers can spend it deliberately', () => {
    expect(profile.capabilities.maxEditsPerMessage).toBe(20);
  });

  it('reads the code off the HTTP error body', async () => {
    const http = Object.assign(new Error('Bad Request'), {
      response: { data: { code: 230072, msg: 'The message has reached the number of times it can be edited.' } },
    });
    await expect(profile.editMessage!(throwingBot(http), ref, 'x')).rejects.toBeInstanceOf(
      MessageNotEditableError
    );
  });

  it('reads the code out of an AggregateError-wrapped message (how satori actually throws it)', async () => {
    const inner = new Error(
      'Bad Request (Lark error code 230072: The message has reached the number of times it can be edited.)'
    );
    await expect(
      profile.editMessage!(throwingBot(new AggregateError([inner], '')), ref, 'x')
    ).rejects.toBeInstanceOf(MessageNotEditableError);
  });

  it('leaves any other failure transient — a rate limit must not fragment the reply', async () => {
    const rateLimited = Object.assign(new Error('Too Many Requests'), {
      response: { data: { code: 99991400, msg: 'rate limited' } },
    });
    const thrown = await profile
      .editMessage!(throwingBot(rateLimited), ref, 'x')
      .catch((e: unknown) => e);
    expect(thrown).toBe(rateLimited);
    expect(thrown).not.toBeInstanceOf(MessageNotEditableError);
  });
});

/**
 * `editButtons` — the page-turn primitive for a paginated card menu.
 *
 * It must go to `im.message.patch` ("更新已发送的消息卡片"), NOT to the profile's own editMessage:
 * that one posts `msg_type:'post'` through `im.message.update`, which cannot touch a card, so a
 * menu edited that way would lose its buttons instead of gaining the next page.
 */
describe('lark editButtons (card patched in place)', () => {
  const profile = createLarkProfile();

  it('declares the capability, separately from editMessage', () => {
    expect(profile.capabilities.editButtons).toBe(true);
  });

  it('patches the same message with a freshly built card', async () => {
    const { bot, calls } = fakeCardBot();
    await profile.editButtons!(bot, { address: { channel: 'oc_1' }, messageId: 'om_42' }, 'page 2', [
      { id: 'mdp:r1:2', label: '▶' },
    ]);
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0]!.messageId).toBe('om_42');
    const card = JSON.parse(calls.patch[0]!.content) as {
      schema: string;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.schema).toBe('2.0');
    expect(card.body.elements[0]).toMatchObject({ tag: 'markdown', content: 'page 2' });
    expect(card.body.elements[1]).toMatchObject({
      tag: 'button',
      behaviors: [{ type: 'callback', value: { id: 'mdp:r1:2' } }],
    });
  });

  it('an empty button list leaves a text-only card (how a menu is retired)', async () => {
    const { bot, calls } = fakeCardBot();
    await profile.editButtons!(bot, { address: { channel: 'oc_1' }, messageId: 'om_42' }, 'done', []);
    const card = JSON.parse(calls.patch[0]!.content) as { body: { elements: unknown[] } };
    expect(card.body.elements).toHaveLength(1);
  });
});

/**
 * Inbound attachment plumbing.
 *
 * adapter-lark is the only adapter here that decodes media into an `internal:` URL — an address
 * nothing but the bot can resolve — so before fetchAttachment every Feishu image and file reached
 * the agent as "[Attachment … failed to download]". These pin the three pure pieces it rests on.
 */
describe('parseLarkResourceUrl', () => {
  it('parses the two URL shapes the adapter mints', () => {
    expect(parseLarkResourceUrl('internal:lark/cli_x/im/v1/messages/om_1/resources/img_v2_ab-cd?type=image')).toEqual({
      messageId: 'om_1',
      fileKey: 'img_v2_ab-cd',
      type: 'image',
    });
    expect(parseLarkResourceUrl('internal:lark/cli_x/im/v1/messages/om_2/resources/file_v2_zz?type=file')).toEqual({
      messageId: 'om_2',
      fileKey: 'file_v2_zz',
      type: 'file',
    });
  });

  it('returns null for a URL this profile does not own (the HTTP path keeps it)', () => {
    expect(parseLarkResourceUrl('https://cdn.example.com/a.png')).toBeNull();
    expect(parseLarkResourceUrl('internal:telegram/bot/x')).toBeNull();
  });

  it('rejects a missing or unexpected type (Feishu requires image|file)', () => {
    expect(parseLarkResourceUrl('internal:lark/cli_x/im/v1/messages/om_1/resources/k')).toBeNull();
    expect(parseLarkResourceUrl('internal:lark/cli_x/im/v1/messages/om_1/resources/k?type=sticker')).toBeNull();
  });

  it('rejects ids outside Feishu\'s alphabet, so nothing can be spliced into the request path', () => {
    // Both ids come off a user-sent event and end up in a request path; a dot, a slash or an
    // escape would let a crafted event address a different Feishu endpoint.
    const bad = [
      'internal:lark/cli_x/im/v1/messages/..%2F..%2Fchats/resources/k?type=file',
      'internal:lark/cli_x/im/v1/messages/om.1/resources/k?type=file',
      'internal:lark/cli_x/im/v1/messages/om_1/resources/k%2E%2E?type=file',
    ];
    for (const url of bad) expect(parseLarkResourceUrl(url)).toBeNull();
  });
});

describe('sniffLarkMedia', () => {
  const bytes = (...b: number[]): Uint8Array => new Uint8Array([...b, ...Array(16).fill(0)]);
  const withAscii = (offset: number, text: string): Uint8Array => {
    const buf = new Uint8Array(32);
    [...text].forEach((c, i) => (buf[offset + i] = c.charCodeAt(0)));
    return buf;
  };

  it('recognizes the formats Feishu delivers as message resources', () => {
    expect(sniffLarkMedia(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.ext).toBe('.png');
    expect(sniffLarkMedia(bytes(0xff, 0xd8, 0xff))?.mime).toBe('image/jpeg');
    expect(sniffLarkMedia(withAscii(0, 'GIF89a'))?.ext).toBe('.gif');
    expect(sniffLarkMedia(withAscii(8, 'WEBP'))?.ext).toBeUndefined(); // RIFF header missing
    const webp = withAscii(0, 'RIFF');
    [...'WEBP'].forEach((c, i) => (webp[8 + i] = c.charCodeAt(0)));
    expect(sniffLarkMedia(webp)?.mime).toBe('image/webp');
    expect(sniffLarkMedia(withAscii(0, '%PDF-1.7'))?.ext).toBe('.pdf');
    expect(sniffLarkMedia(bytes(0x50, 0x4b, 0x03, 0x04))?.mime).toBe('application/zip');
    expect(sniffLarkMedia(withAscii(4, 'ftyp'))?.ext).toBe('.mp4');
    expect(sniffLarkMedia(withAscii(0, 'OggS'))?.mime).toBe('audio/ogg');
  });

  it('unknown bytes and a truncated buffer report nothing rather than guessing', () => {
    // A wrong extension is worse than none: the agent picks its tool by it.
    expect(sniffLarkMedia(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(sniffLarkMedia(new Uint8Array())).toBeUndefined();
  });
});

describe('extractResourceNames', () => {
  const body = (content: string): unknown => ({
    type: 'im.message.receive_v1',
    event: { message: { message_id: 'om_1', content } },
  });

  it('recovers the filename a file message declares (the adapter drops it)', () => {
    expect(extractResourceNames(body('{"file_key":"file_v2_z","file_name":"季度报告.pdf"}'))).toEqual([
      { key: 'file_v2_z', name: '季度报告.pdf' },
    ]);
  });

  it('an image message declares no name, so there is nothing to learn', () => {
    expect(extractResourceNames(body('{"image_key":"img_v2_a"}'))).toEqual([]);
  });

  it('a non-message event or malformed content yields nothing, never a throw', () => {
    expect(extractResourceNames(body('not json'))).toEqual([]);
    expect(extractResourceNames({ type: 'card.action.trigger' })).toEqual([]);
    expect(extractResourceNames(undefined)).toEqual([]);
  });
});

/**
 * Rich text (富文本, msg_type: 'post').
 *
 * adapter-lark decodes nothing for this message type, so the whole message used to arrive empty
 * and be dropped by the gate as `empty` — a message that had @-mentioned the bot, ignored with no
 * log line. These pin the rebuild, and especially the mention: a post's `at` carries a
 * placeholder, so passing it through would leave detectMention permanently blind in rich text.
 */
describe('larkPostElements', () => {
  const url = (type: 'image' | 'file', messageId: string, key: string): string =>
    `internal:lark/cli_x/im/v1/messages/${messageId}/resources/${key}?type=${type}`;

  const postBody = (post: unknown, mentions?: unknown[]): unknown => ({
    type: 'im.message.receive_v1',
    event: {
      message: {
        message_id: 'om_1',
        message_type: 'post',
        content: JSON.stringify(post),
        ...(mentions ? { mentions } : {}),
      },
    },
  });

  it('rebuilds title, text, links and images in order', () => {
    const els = larkPostElements(
      postBody({
        title: '周报',
        content: [
          [
            { tag: 'text', text: 'see ' },
            { tag: 'a', href: 'https://x.dev', text: 'the docs' },
          ],
          [{ tag: 'img', image_key: 'img_v2_a' }],
        ],
      }),
      url
    );
    expect(els?.map((e) => e.toString()).join('')).toBe(
      '周报\nsee [the docs](https://x.dev)\n<img src="internal:lark/cli_x/im/v1/messages/om_1/resources/img_v2_a?type=image"/>'
    );
  });

  it('resolves an @mention placeholder to the real open_id', () => {
    // The load-bearing case: `user_id` in a post is '@_user_1', and the open_id lives in
    // `mentions`. detectMention compares against the bot's open_id, so an unresolved placeholder
    // means "not mentioned" forever.
    const els = larkPostElements(
      postBody({ content: [[{ tag: 'at', user_id: '@_user_1', user_name: 'bot' }]] }, [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'agent' },
      ]),
      url
    );
    expect(els).toEqual([{ type: 'at', attrs: { id: 'ou_bot', name: 'agent' }, children: [] }]);
  });

  it('degrades @_all and an unknown placeholder to text', () => {
    const all = larkPostElements(postBody({ content: [[{ tag: 'at', user_id: '@_all' }]] }), url);
    expect(all?.[0]?.attrs?.['content']).toBe('@all');
    const unknown = larkPostElements(
      postBody({ content: [[{ tag: 'at', user_id: '@_user_9', user_name: '张三' }]] }),
      url
    );
    expect(unknown?.[0]?.attrs?.['content']).toBe('@张三');
  });

  it('maps media to a file element addressed like a standalone file message', () => {
    const els = larkPostElements(
      postBody({ content: [[{ tag: 'media', file_key: 'file_v2_z', file_name: 'demo.mp4' }]] }),
      url
    );
    expect(els?.[0]?.attrs?.['src']).toBe(
      'internal:lark/cli_x/im/v1/messages/om_1/resources/file_v2_z?type=file'
    );
    // …and that name is learned too, so the download does not fall back to the resource key.
    expect(
      extractResourceNames(
        postBody({ content: [[{ tag: 'media', file_key: 'file_v2_z', file_name: 'demo.mp4' }]] })
      )
    ).toEqual([{ key: 'file_v2_z', name: 'demo.mp4' }]);
  });

  it('renders the decorative tags an agent can still read', () => {
    const els = larkPostElements(
      postBody({
        content: [
          [{ tag: 'code_block', language: 'ts', text: 'const a = 1' }],
          [{ tag: 'hr' }, { tag: 'emotion', emoji_type: 'SMILE' }, { tag: 'br' }],
        ],
      }),
      url
    );
    const text = els?.map((e) => e.attrs?.['content'] ?? '').join('');
    expect(text).toContain('```ts\nconst a = 1\n```');
    expect(text).toContain('---');
    expect(text).toContain(':SMILE:');
  });

  it('leaves anything that is not a post alone', () => {
    expect(larkPostElements({ type: 'im.message.receive_v1', event: { message: { message_type: 'text', message_id: 'om_1', content: '{"text":"hi"}' } } }, url)).toBeUndefined();
    expect(larkPostElements({ type: 'card.action.trigger' }, url)).toBeUndefined();
    expect(larkPostElements(undefined, url)).toBeUndefined();
  });

  it('malformed content, or content with nothing renderable, reports nothing', () => {
    // The hook only assigns when this returns elements, so `undefined` means "leave the session
    // exactly as the adapter left it" — never "replace it with an empty message".
    const broken = {
      type: 'im.message.receive_v1',
      event: { message: { message_id: 'om_1', message_type: 'post', content: 'not json' } },
    };
    expect(larkPostElements(broken, url)).toBeUndefined();
    expect(larkPostElements(postBody({ content: [[{ tag: 'sticker', key: 'x' }]] }), url)).toBeUndefined();
  });
});
