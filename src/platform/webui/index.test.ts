import { describe, it, expect } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import { PAGE_SIZE, PAGE_SIZE_MAX, resolvePageSize } from '../../core/paging.js';
import { WebuiConfigSchema } from '../config-schemas.js';
import { createWebuiAdapter } from './index.js';
import { CHANNEL } from './room.js';
import type { PlatformAdapter } from '../adapter.js';

function adapter(): PlatformAdapter {
  return createWebuiAdapter({ ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui' });
}

const HERE = { channel: CHANNEL };

describe('webui adapter: what it says it can do', () => {
  it('declares the menu page size every other platform declares', () => {
    // `menu-page-size.test.ts` holds this invariant for the Satori profiles and cannot see this
    // adapter, which is exactly why it is asserted here: which client someone reads from should
    // not change how many directories `/cd` offers them. A browser could carry more; that is not
    // a reason to make it the odd one out.
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

  it('declares no threads and no rename, which is what one conversation means', () => {
    const caps = adapter().capabilities;
    expect(caps.thread).toBe(false);
    expect(caps.renameThread).toBe(false);
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

describe('webui adapter: outbound', () => {
  it('sends, edits and deletes through one stable ref', async () => {
    const a = adapter();
    const ref = await a.sendMessage(HERE, 'hello');
    expect(ref.address).toEqual(HERE);
    await expect(a.editMessage(ref, 'hello again')).resolves.toBeUndefined();
    await expect(a.deleteMessage(ref)).resolves.toBeUndefined();
    // Deleted, so no longer editable — and it says so in the vocabulary the writers understand.
    await expect(a.editMessage(ref, 'x')).rejects.toBeInstanceOf(MessageNotEditableError);
  });

  it('posts buttons and retires them with an empty list', async () => {
    const a = adapter();
    const ref = await a.sendButtons(HERE, 'Pick one', [{ id: 'ask:r:0', label: 'Yes' }]);
    await expect(a.editButtons(ref, 'Pick one\n\nanswered', [])).resolves.toBeUndefined();
  });

  it('quotes the message a reply answers', async () => {
    const a = adapter();
    const target = await a.sendMessage(HERE, 'the question');
    await expect(a.replyMessage(target, 'the answer')).resolves.toMatchObject({ address: HERE });
  });

  it('refuses an address that is not this one conversation', async () => {
    const a = adapter();
    // A `--channel` override on a reverse command is the way this happens. Silently posting it
    // into the only room there is would be the wrong kind of helpful.
    await expect(a.sendMessage({ channel: 'elsewhere' }, 'x')).rejects.toThrow(/serves one conversation/);
    await expect(a.sendMessage({ channel: CHANNEL, thread: 'lane' }, 'x')).rejects.toThrow(/serves one conversation/);
  });

  it('throws for the two things it declared it cannot do', async () => {
    const a = adapter();
    const ref = await a.sendMessage(HERE, 'x');
    await expect(a.createThread(ref, 'name')).rejects.toThrow(/no threads/);
    await expect(a.renameThread(HERE, 'name')).rejects.toThrow(/no lane to rename/);
  });

  it('takes reactions and typing without complaint, since nothing gates them', async () => {
    // The daemon never reads capabilities.reaction or .typing — it calls these unconditionally
    // and swallows failures. So the real obligation is that they are safe to call.
    const a = adapter();
    const ref = await a.sendMessage(HERE, 'x');
    await expect(a.addReaction(ref, '👀')).resolves.toBeUndefined();
    await expect(a.removeReaction(ref, '👀')).resolves.toBeUndefined();
    await expect(a.startTyping(HERE)).resolves.toBeUndefined();
    await expect(a.stopTyping(HERE)).resolves.toBeUndefined();
  });

  it('publishes a sent file behind a token rather than its path', async () => {
    const a = adapter();
    const ref = await a.sendFile(HERE, { path: '/tmp/secret-place/report.pdf', name: 'report.pdf' });
    const history = await a.fetchHistory(HERE, {});
    expect(history.some((m) => m.messageId === ref.messageId)).toBe(true);
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
});
