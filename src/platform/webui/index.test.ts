import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import { PAGE_SIZE, PAGE_SIZE_MAX, resolvePageSize } from '../../core/paging.js';
import { WebuiConfigSchema } from '../config-schemas.js';
import { createWebuiAdapter } from './index.js';
import { CHANNEL } from './room.js';
import type { ConversationAddress } from '../../core/conversation.js';
import type { PlatformAdapter } from '../adapter.js';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-adapter-'));
  saved = process.env.AGENT_ANYWHERE_CONFIG_DIR;
  process.env.AGENT_ANYWHERE_CONFIG_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_ANYWHERE_CONFIG_DIR;
  else process.env.AGENT_ANYWHERE_CONFIG_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

function adapter(): PlatformAdapter {
  return createWebuiAdapter({ ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui' });
}

/** The adapter opens one topic on a fresh install; this is how a test gets an address into it. */
async function somewhere(a: PlatformAdapter): Promise<ConversationAddress> {
  const { address } = await a.createThread({ address: { channel: CHANNEL }, messageId: '' }, 'a topic');
  return address;
}

describe('webui adapter: what it says it can do', () => {
  it('declares topics, and that they can be named', () => {
    const caps = adapter().capabilities;
    expect(caps.thread).toBe(true);
    // Only true because a topic IS a lane: `retitleLane` refuses any address without one, so
    // the channel-per-topic alternative would have left this permanently inert.
    expect(caps.renameThread).toBe(true);
  });

  it('declares the menu page size every other platform declares', () => {
    // `menu-page-size.test.ts` holds this invariant for the Satori profiles and cannot see this
    // adapter, which is exactly why it is asserted here: which client someone reads from should
    // not change how many directories `/cd` offers them.
    const size = adapter().capabilities.menuPageSize;
    expect(size).toBe(12);
    expect(size).toBeGreaterThan(PAGE_SIZE);
    expect(size).toBeLessThanOrEqual(PAGE_SIZE_MAX);
    expect(resolvePageSize(size)).toBe(size);
  });

  it('claims buttons AND editButtons, without which /model, /cd and /setting degrade to text', () => {
    const caps = adapter().capabilities;
    expect(caps.buttons).toBe(true);
    expect(caps.editButtons).toBe(true);
  });

  it('leaves the per-message edit budget unset, because nothing here refuses an edit', () => {
    expect(adapter().capabilities.maxEditsPerMessage).toBeUndefined();
  });

  it('measures the raw markdown, never the html it renders', () => {
    // maxMessageLength bounds the text the writer is chunking. Measuring the rendered html
    // would make a fenced code block read several times its real size and chop replies at a
    // fraction of the stated limit for no reason.
    const src = '```\nconst a = 1 < 2 && 3 > 2;\n```';
    expect(adapter().measureRendered(src)).toBe(src.length);
  });
});

describe('webui adapter: topics', () => {
  it('opens a topic and returns it as a lane', async () => {
    const a = adapter();
    const address = await somewhere(a);
    // The shape `adapter.ts` documents for a platform whose threads are lanes, and what
    // `--channel main/<id>` parses back to.
    expect(address).toEqual({ channel: CHANNEL, thread: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string });
  });

  it('names a topic', async () => {
    const a = adapter();
    const address = await somewhere(a);
    // The string the automatic namer produces (`formatLaneTitle`), which is what actually
    // arrives here in a real turn.
    await expect(a.renameThread(address, '[cc] fix the login timeout')).resolves.toBeUndefined();
  });

  it('refuses an address that is not one of its topics', async () => {
    const a = adapter();
    // A `--channel` override on a reverse command is how this happens. Posting it into
    // whichever room happened to be first would be the wrong kind of helpful.
    await expect(a.sendMessage({ channel: 'elsewhere', thread: 'x' }, 'x')).rejects.toThrow(/addresses topics as/);
    await expect(a.sendMessage({ channel: CHANNEL }, 'x')).rejects.toThrow(/addresses topics as/);
    await expect(a.sendMessage({ channel: CHANNEL, thread: 'deadbeef' }, 'x')).rejects.toThrow(/no such topic/);
  });

  it('keeps each topic history to itself', async () => {
    const a = adapter();
    const one = await somewhere(a);
    const two = await somewhere(a);
    await a.sendMessage(one, 'in one');
    expect((await a.fetchHistory(one, {})).map((m) => m.content)).toEqual(['in one']);
    expect(await a.fetchHistory(two, {})).toEqual([]);
  });
});

describe('webui adapter: outbound', () => {
  it('sends, edits and deletes through one stable ref', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendMessage(address, 'hello');
    expect(ref.address).toEqual(address);
    await expect(a.editMessage(ref, 'hello again')).resolves.toBeUndefined();
    await expect(a.deleteMessage(ref)).resolves.toBeUndefined();
    // Deleted, so no longer editable — and it says so in the vocabulary the writers understand.
    await expect(a.editMessage(ref, 'x')).rejects.toBeInstanceOf(MessageNotEditableError);
  });

  it('posts buttons and retires them with an empty list', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendButtons(address, 'Pick one', [{ id: 'ask:r:0', label: 'Yes' }]);
    await expect(a.editButtons(ref, 'Pick one\n\nanswered', [])).resolves.toBeUndefined();
  });

  it('quotes the message a reply answers', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const target = await a.sendMessage(address, 'the question');
    await expect(a.replyMessage(target, 'the answer')).resolves.toMatchObject({ address });
  });

  it('takes reactions and typing without complaint, since nothing gates them', async () => {
    // The daemon never reads capabilities.reaction or .typing — it calls these unconditionally
    // and swallows failures. So the real obligation is that they are safe to call.
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendMessage(address, 'x');
    await expect(a.addReaction(ref, '👀')).resolves.toBeUndefined();
    await expect(a.removeReaction(ref, '👀')).resolves.toBeUndefined();
    await expect(a.startTyping(address)).resolves.toBeUndefined();
    await expect(a.stopTyping(address)).resolves.toBeUndefined();
  });

  it('publishes a sent file behind a token rather than its path', async () => {
    const a = adapter();
    const address = await somewhere(a);
    const ref = await a.sendFile(address, { path: '/tmp/secret-place/report.pdf', name: 'report.pdf' });
    expect((await a.fetchHistory(address, {})).some((m) => m.messageId === ref.messageId)).toBe(true);
  });

  it('accepts all three inbound registrations, including the one it never calls', () => {
    // The daemon wires onMessage/onButton/onCommand on every adapter before starting it, so
    // refusing the slash-interaction one would fail Daemon.run() — even though a slash command
    // reaches this platform as an ordinary message and no interaction is ever emitted.
    const a = adapter();
    expect(() => {
      a.onMessage(() => {});
      a.onButton(() => {});
      a.onCommand(() => {});
    }).not.toThrow();
  });

  it('remembers its topics across a restart', async () => {
    const first = adapter();
    const address = await somewhere(first);
    // A second adapter over the same config dir is what a daemon restart looks like from here.
    await expect(adapter().sendMessage(address, 'still there')).resolves.toBeDefined();
  });
});
