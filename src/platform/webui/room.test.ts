import { describe, it, expect, vi } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import { WebuiConfigSchema } from '../config-schemas.js';
import { CHANNEL, OWNER, WebRoom, type WebuiInstance } from './room.js';
import type { InboundMessage } from '../../types.js';
import type { WebEvent } from './protocol.js';

function instance(over: Partial<WebuiInstance> = {}): WebuiInstance {
  return { ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui', ...over };
}

/** A room with a subscribed client whose events the test can read back. */
function attached(over?: Partial<WebuiInstance>): { room: WebRoom; events: WebEvent[]; off: () => void } {
  const room = new WebRoom(instance(over));
  const events: WebEvent[] = [];
  const off = room.subscribe((ev) => events.push(ev));
  return { room, events, off };
}

describe('WebRoom: outbound', () => {
  it('accepts a message with nobody watching', () => {
    // The contract the whole adapter rests on. A room that refused when no browser was open
    // would fail every turn started before someone opened the page — and the daemon would
    // report that failure by posting into the same empty room.
    const room = new WebRoom(instance());
    expect(room.watchers).toBe(0);
    expect(() => room.post({ own: false, html: '<p>hi</p>' }, 'hi')).not.toThrow();
  });

  it('replays the whole room to a client that attaches, including the typing state', () => {
    const room = new WebRoom(instance());
    room.post({ own: false, html: '<p>a</p>' }, 'a');
    room.setTyping(true);
    const seen: WebEvent[] = [];
    room.subscribe((ev) => seen.push(ev));
    expect(seen[0]).toMatchObject({ t: 'sync', messages: [{ html: '<p>a</p>' }] });
    expect(seen[1]).toEqual({ t: 'typing', on: true });
  });

  it('mints ids that are unique and never reused, even across eviction', () => {
    // Not cosmetic: the outbound pacer coalesces edits into `edit:<channel>:<messageId>`, and
    // with one channel that key IS the id, so a reused one silently supersedes another
    // message's edits.
    const room = new WebRoom(instance());
    const ids = new Set<string>();
    for (let i = 0; i < 600; i += 1) ids.add(room.post({ own: false, html: '' }, '').id);
    expect(ids.size).toBe(600);
  });

  it('revises a message in place and tells every client', () => {
    const { room, events } = attached();
    const msg = room.post({ own: false, html: '' }, '');
    room.revise(msg.id, '**b**');
    const last = events[events.length - 1];
    expect(last).toMatchObject({ t: 'msg', msg: { id: msg.id, html: '<p><strong>b</strong></p>' } });
  });

  it('throws MessageNotEditableError for an id it no longer holds', () => {
    // Specifically that type, because it means "this message will never accept another edit",
    // which is exactly true of an evicted one. StreamBuffer answers it by sealing and
    // continuing in a fresh message; a silent success would have it record text as delivered
    // that nobody can see.
    const room = new WebRoom(instance());
    const first = room.post({ own: false, html: '' }, '');
    for (let i = 0; i < 500; i += 1) room.post({ own: false, html: '' }, '');
    expect(() => room.revise(first.id, 'x')).toThrow(MessageNotEditableError);
    expect(() => room.revise('never-existed', 'x')).toThrow(MessageNotEditableError);
  });

  it('strips buttons when handed an empty list, which is how every menu is retired', () => {
    const { room, events } = attached();
    const msg = room.post({ own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'Yes' }] }, '');
    room.revise(msg.id, 'answered', []);
    expect((events[events.length - 1] as { msg: { buttons: unknown[] } }).msg.buttons).toEqual([]);
  });

  it('carries reactions on the message as well as announcing them, so a reload keeps them', () => {
    const { room, events } = attached();
    const msg = room.post({ own: false, html: '' }, '');
    room.react(msg.id, '👀', true);
    expect(events[events.length - 1]).toEqual({ t: 'react', id: msg.id, emoji: '👀', on: true });
    room.react(msg.id, '✅', true);
    room.react(msg.id, '👀', false);
    const seen: WebEvent[] = [];
    room.subscribe((ev) => seen.push(ev));
    expect(seen[0]).toMatchObject({ t: 'sync', messages: [{ reactions: ['✅'] }] });
  });

  it('ignores a reaction on an unknown message instead of throwing', () => {
    // Unlike an edit: a reaction that cannot land costs nothing, and every caller of these
    // already swallows failures, so throwing would only add noise to a log.
    const room = new WebRoom(instance());
    expect(() => room.react('gone', '✅', true)).not.toThrow();
  });

  it('deleting something already gone is success', () => {
    const room = new WebRoom(instance());
    expect(() => room.remove('gone')).not.toThrow();
  });

  it('drops a client that throws rather than letting it take the turn down', () => {
    const room = new WebRoom(instance());
    room.subscribe(() => {
      throw new Error('socket is gone');
    });
    expect(() => room.post({ own: false, html: '' }, '')).not.toThrow();
    expect(room.watchers).toBe(0);
  });

  it('does not re-announce a typing state that has not changed', () => {
    const { room, events } = attached();
    const before = events.length;
    room.setTyping(true);
    room.setTyping(true);
    expect(events.length).toBe(before + 1);
  });
});

describe('WebRoom: inbound', () => {
  it('echoes the operator message and hands the daemon the SAME id', () => {
    // They must match: the daemon reacts on the inbound id (👀 / ✅), and a mismatch would
    // leave every lifecycle reaction pointing at a message the page does not hold.
    const { room, events } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ text: 'hello' });
    const echoed = (events[events.length - 1] as { msg: { id: string; own: boolean } }).msg;
    expect(echoed.own).toBe(true);
    expect(got[0]?.messageId).toBe(echoed.id);
    expect(got[0]?.content).toBe('hello');
    expect(got[0]?.conversation).toEqual({ platform: 'webui', channel: CHANNEL, kind: 'direct', user: OWNER });
  });

  it('turns an upload into a data: URL, the one shape the SSRF guard has a branch for', () => {
    const room = new WebRoom(instance());
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ text: '', files: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }] });
    expect(got[0]?.attachments).toEqual([
      { type: 'image', url: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png' },
    ]);
  });

  it('classifies a non-image upload as a file and survives a browser that reported no type', () => {
    const room = new WebRoom(instance());
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ text: '', files: [{ name: 'x.bin', mime: '', data: 'AA' }] });
    expect(got[0]?.attachments?.[0]).toMatchObject({ type: 'file', url: 'data:application/octet-stream;base64,AA' });
  });

  it('ignores an empty submission', () => {
    const room = new WebRoom(instance());
    const onMsg = vi.fn();
    room.onMessage(onMsg);
    room.submit({ text: '   ' });
    expect(onMsg).not.toHaveBeenCalled();
  });

  it('applies chat.channels, which satori-core applies for every other platform', () => {
    const muted = new WebRoom(instance({ chat: { ...instance().chat, channels: ['somewhere-else'] } }));
    const onMsg = vi.fn();
    muted.onMessage(onMsg);
    muted.submit({ text: 'hi' });
    expect(onMsg).not.toHaveBeenCalled();

    const listed = new WebRoom(instance({ chat: { ...instance().chat, channels: [CHANNEL] } }));
    const heard = vi.fn();
    listed.onMessage(heard);
    listed.submit({ text: 'hi' });
    expect(heard).toHaveBeenCalledOnce();
  });

  it('refuses a click naming a message it does not hold', () => {
    // The daemon's click handlers go on to EDIT the message the id names, and the id comes
    // from the page — so a stale tab or a hand-made request must stop here.
    const room = new WebRoom(instance());
    const onBtn = vi.fn();
    room.onButton(onBtn);
    expect(room.click({ messageId: 'nope', buttonId: 'ask:r:0' })).toBe(false);
    expect(onBtn).not.toHaveBeenCalled();
  });

  it('forwards a click with the same conversation a message carries', () => {
    const room = new WebRoom(instance());
    const clicks: Array<{ conversation: unknown; buttonId: string }> = [];
    room.onButton((ev) => clicks.push(ev));
    const msg = room.post({ own: false, html: '', buttons: [{ id: 'mdl:r:1', label: 'x' }] }, '');
    expect(room.click({ messageId: msg.id, buttonId: 'mdl:r:1' })).toBe(true);
    // Identical to the message path, because `access.allowFrom` is re-checked on every menu
    // click as `<platform>:<user>` — a click carrying a different user is silently denied.
    expect(clicks[0]?.conversation).toEqual({ platform: 'webui', channel: CHANNEL, kind: 'direct', user: OWNER });
    expect(clicks[0]?.buttonId).toBe('mdl:r:1');
  });
});

describe('WebRoom: history and downloads', () => {
  it('returns the markdown it was given, not the html it rendered', () => {
    const room = new WebRoom(instance());
    room.post({ own: false, html: '<p><strong>b</strong></p>' }, '**b**');
    expect(room.history({})[0]?.content).toBe('**b**');
  });

  it('honours limit and before', () => {
    const room = new WebRoom(instance());
    const ids = [1, 2, 3, 4].map((n) => room.post({ own: false, html: '' }, `m${n}`).id);
    expect(room.history({ limit: 2 }).map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(room.history({ before: ids[2] }).map((m) => m.content)).toEqual(['m1', 'm2']);
  });

  it('marks who said what, so a replay reads as a conversation', () => {
    const room = new WebRoom(instance());
    room.submit({ text: 'mine' });
    room.post({ own: false, html: '', ...{} }, 'theirs');
    expect(room.history({}).map((m) => m.authorIsBot)).toEqual([false, true]);
  });

  it('hands out an opaque, page-relative token for a file and resolves it back', () => {
    const room = new WebRoom(instance());
    const url = room.publish('/tmp/report.pdf', 'report.pdf');
    // Relative so the page keeps working under a reverse-proxy sub-path, and opaque so the
    // path never reaches the browser and the browser can never name one.
    expect(url).toMatch(/^f\/[0-9a-f]{32}$/);
    expect(url).not.toContain('tmp');
    expect(room.resolveDownload(url.slice(2))).toEqual({ path: '/tmp/report.pdf', name: 'report.pdf' });
  });

  it('bounds the download table instead of growing it for the life of the daemon', () => {
    const room = new WebRoom(instance());
    const first = room.publish('/tmp/a', 'a').slice(2);
    for (let i = 0; i < 200; i += 1) room.publish(`/tmp/${i}`, 'x');
    expect(room.resolveDownload(first)).toBeUndefined();
  });
});
