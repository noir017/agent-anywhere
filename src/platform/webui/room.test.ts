import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MessageNotEditableError } from '../../core/outbound-errors.js';
import { WebuiConfigSchema } from '../config-schemas.js';
import { CHANNEL, DIR_TTL_MS, OWNER, WebRoom, type WebuiInstance } from './room.js';
import { TopicStore } from './topics.js';
import type { InboundMessage } from '../../types.js';
import type { WebEvent } from './protocol.js';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-room-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function instance(over: Partial<WebuiInstance> = {}): WebuiInstance {
  return { ...WebuiConfigSchema.parse({ type: 'webui', token: 'secret' }), id: 'webui', ...over };
}

interface Seen {
  id: string;
  ev: WebEvent;
}

/** A room with one topic and a client attached to it, whose events the test can read back. */
function attached(over?: Partial<WebuiInstance>): {
  room: WebRoom;
  topic: string;
  seen: Seen[];
  off: () => void;
} {
  const store = new TopicStore(path.join(dir, `${Math.random()}.json`));
  const room = new WebRoom(instance(over), store);
  const topic = store.current().id;
  const seen: Seen[] = [];
  const off = room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
  return { room, topic, seen, off };
}

const kinds = (seen: Seen[]): string[] => seen.map((s) => s.ev.t);
const last = (seen: Seen[]): WebEvent | undefined => seen[seen.length - 1]?.ev;

describe('WebRoom: topics are separate conversations', () => {
  it('keeps two topics' + " messages and streams apart", () => {
    const store = new TopicStore(path.join(dir, 't.json'));
    const room = new WebRoom(instance(), store);
    const a = store.create('a').id;
    const b = store.create('b').id;
    const seenA: Seen[] = [];
    room.subscribe(a, (id, ev) => seenA.push({ id, ev }));

    room.post(b, { own: false, html: '<p>in b</p>' }, 'in b');
    // A client reading one room is not billed for traffic in another — the point of a
    // per-topic stream on a weak link. Only the topic list crosses.
    expect(kinds(seenA).filter((k) => k === 'msg')).toEqual([]);
    expect(kinds(seenA)).toContain('topics');

    room.post(a, { own: false, html: '<p>in a</p>' }, 'in a');
    expect(seenA.filter((s) => s.ev.t === 'msg')).toHaveLength(1);
  });

  it('addresses a topic as a lane, and as a DM', () => {
    const { room, topic } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ topic, text: 'hi' });
    // `kind: 'direct'` even with a lane set, deliberately: with 'thread' the inbound gate falls
    // through to its mention requirement and a brand-new topic's FIRST message is dropped.
    expect(got[0]?.conversation).toEqual({
      platform: 'webui',
      channel: CHANNEL,
      thread: topic,
      kind: 'direct',
      user: OWNER,
    });
  });

  it('applies chat.channels per lane', () => {
    const store = new TopicStore(path.join(dir, 'c.json'));
    const topic = store.create().id;
    // A bare channel entry covers every topic in it; a lane entry names one.
    const broad = new WebRoom(instance({ chat: { ...instance().chat, channels: [CHANNEL] } }), store);
    const heard = vi.fn();
    broad.onMessage(heard);
    broad.submit({ topic, text: 'hi' });
    expect(heard).toHaveBeenCalledOnce();

    const narrow = new WebRoom(instance({ chat: { ...instance().chat, channels: [`${CHANNEL}/other123`] } }), store);
    const muted = vi.fn();
    narrow.onMessage(muted);
    narrow.submit({ topic, text: 'hi' });
    expect(muted).not.toHaveBeenCalled();
  });

  it('refuses a message or a click for a topic that does not exist', () => {
    const { room } = attached();
    const onMsg = vi.fn();
    const onBtn = vi.fn();
    room.onMessage(onMsg);
    room.onButton(onBtn);
    expect(room.submit({ topic: 'deadbeef', text: 'hi' })).toBe('unknown-topic');
    expect(room.click({ topic: 'deadbeef', messageId: 'w1', buttonId: 'ask:r:0' })).toBe(false);
    expect(onMsg).not.toHaveBeenCalled();
    expect(onBtn).not.toHaveBeenCalled();
  });

  it('announces the topic list when one is created, renamed or spoken in', () => {
    const { room, topic, seen } = attached();
    seen.length = 0;
    room.createTopic('second');
    expect(last(seen)).toMatchObject({ t: 'topics' });
    seen.length = 0;
    room.renameTopic(topic, '[cc] a subject');
    expect(last(seen)).toMatchObject({ t: 'topics' });
    expect((last(seen) as { topics: Array<{ title: string }> }).topics.some((t) => t.title === '[cc] a subject')).toBe(true);
  });

  it('tracks running state and msgCount in the topic list', () => {
    const { room, topic, seen } = attached();
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(false);
    expect(room.topicList().find((t) => t.id === topic)?.msgCount).toBe(0);

    // Typing sets running: true and announces
    seen.length = 0;
    room.setTyping(topic, true);
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(true);
    expect(seen.some((s) => s.ev.t === 'topics')).toBe(true);

    // Posting a message increments msgCount
    room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi');
    expect(room.topicList().find((t) => t.id === topic)?.msgCount).toBe(1);

    // Stopping typing sets running: false and announces
    seen.length = 0;
    room.setTyping(topic, false);
    expect(room.topicList().find((t) => t.id === topic)?.running).toBe(false);
    expect(seen.some((s) => s.ev.t === 'topics')).toBe(true);
  });

  it('deletes a topic, cleans up room state, and announces the updated list', () => {
    const { room, seen } = attached();
    const second = room.createTopic('second');
    room.post(second.id, { own: false, html: '<p>msg</p>' }, 'msg');
    seen.length = 0;

    expect(room.deleteTopic(second.id)).toBe(true);
    expect(room.topicList().some((t) => t.id === second.id)).toBe(false);
    expect(last(seen)).toMatchObject({ t: 'topics' });
    expect((last(seen) as { topics: Array<{ id: string }> }).topics.some((t) => t.id === second.id)).toBe(false);

    // Deleting again returns false
    expect(room.deleteTopic(second.id)).toBe(false);
  });

  it('clears every topic at once, announcing the replacement rather than each removal', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const second = room.createTopic('second');
    const msg = room.post(second.id, { own: false, html: '<p>msg</p>' }, 'msg');
    // An edit left in flight, so the sweep is proved to stop the timers rather than leave one
    // armed to fire into a room that no longer exists.
    room.revise(second.id, msg.id, 'still typing');
    seen.length = 0;

    const fresh = room.clearTopics();

    expect(room.topicList().map((t) => t.id)).toEqual([fresh.id]);
    expect(fresh.id).not.toBe(topic);
    expect(fresh.id).not.toBe(second.id);
    // One announcement for the whole sweep, not one per topic dropped.
    expect(kinds(seen)).toEqual(['topics']);
    expect((last(seen) as { topics: Array<{ id: string }> }).topics.map((t) => t.id)).toEqual([fresh.id]);

    vi.advanceTimersByTime(60_000);
    expect(kinds(seen)).toEqual(['topics']);
  });
});

describe('WebRoom: held edits', () => {
  it('does not announce an edit immediately', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'one');
    room.revise(topic, msg.id, 'one two');
    expect(seen).toHaveLength(0);
  });

  it('announces once, with the newest text, after it settles', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'one');
    room.revise(topic, msg.id, 'one two');
    room.revise(topic, msg.id, 'one two three');
    vi.advanceTimersByTime(1_600);
    expect(seen).toHaveLength(1);
    // The queue holds the id, not a snapshot, so what goes out is the newest state rather than
    // whichever revision happened to be enqueued first.
    expect(last(seen)).toMatchObject({ t: 'msg', msg: { html: '<p>one two three</p>' } });
  });

  it('re-arms while a reply keeps streaming, but never holds past the cap', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    // A reply flushing at the daemon's own 1.2s cadence would re-arm a 1.5s settle forever;
    // the cap is what keeps the page from looking frozen through a long answer.
    for (let i = 0; i < 10; i += 1) {
      room.revise(topic, msg.id, `chunk ${i}`);
      vi.advanceTimersByTime(1_200);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(5);
  });

  it.each([
    ['a new message', (r: WebRoom, t: string) => void r.post(t, { own: false, html: '' }, '')],
    ['a reaction', (r: WebRoom, t: string, id: string) => r.react(t, id, '✅', true)],
    ['typing', (r: WebRoom, t: string) => r.setTyping(t, true)],
    ['a delete', (r: WebRoom, t: string, id: string) => r.remove(t, id)],
  ])('flushes what is held before %s, so the page reads in order', (_label, act) => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'the held edit');
    act(room, topic, msg.id);
    // The held edit must be the FIRST thing out, not the last: a tool bubble whose final state
    // arrives below the text that followed it is the scrambled transcript
    // `daemon/render-order.test.ts` exists for, one layer up.
    expect(seen[0]?.ev).toMatchObject({ t: 'msg', msg: { id: msg.id, html: '<p>the held edit</p>' } });
    expect(seen.length).toBeGreaterThan(1);
  });

  it('sends what is held when the daemon shuts down', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'last words');
    room.dispose();
    expect(last(seen)).toMatchObject({ t: 'msg', msg: { html: '<p>last words</p>' } });
  });
});

describe('WebRoom: resuming a dropped stream', () => {
  it('numbers events per topic and lets a client resume from the last it saw', () => {
    const { room, topic, seen, off } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    const identified = seen.filter((s) => s.id !== '');
    const lastId = identified[identified.length - 1]?.id ?? '';
    expect(lastId).toMatch(new RegExp(`^${topic}\\.\\d+$`));
    off();

    room.post(topic, { own: false, html: '<p>two</p>' }, 'two');
    room.post(topic, { own: false, html: '<p>three</p>' }, 'three');

    const resumed: Seen[] = [];
    room.subscribe(topic, (id, ev) => resumed.push({ id, ev }), lastId);
    // Only what was missed — not the whole conversation, which is what this used to cost on
    // every network blip.
    expect(kinds(resumed).filter((k) => k === 'sync')).toEqual([]);
    expect(resumed.filter((s) => s.ev.t === 'msg')).toHaveLength(2);
  });

  it('gives the cross-topic list event no id, so it cannot move a resume point', () => {
    // `topics` is the one event that crosses rooms, so it is in no topic's backlog and nothing
    // could be resumed from it. A browser only advances Last-Event-ID when it sees an `id:`
    // field, so leaving it off keeps the resume point pointing at the last event that IS
    // replayable — numbering it would silently break the resume it looks like it enables.
    const { room, seen } = attached();
    seen.length = 0;
    room.createTopic('another');
    expect(seen.map((s) => [s.ev.t, s.id])).toEqual([['topics', '']]);
  });

  it('falls back to a full sync when it has nothing to resume from', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>one</p>' }, 'one');
    for (const lastId of [undefined, 'garbage', `${topic}.notanumber`, 'someothertopic.1']) {
      const seen: Seen[] = [];
      room.subscribe(topic, (id, ev) => seen.push({ id, ev }), lastId);
      expect(seen[0]?.ev.t).toBe('sync');
    }
  });

  it('falls back to a full sync rather than handing over a transcript with a hole in it', () => {
    const { room, topic } = attached();
    // Further back than the backlog keeps: the gap cannot be filled, and pretending otherwise
    // would silently drop messages out of the middle of the conversation.
    for (let i = 0; i < 400; i += 1) room.post(topic, { own: false, html: '' }, '');
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }), `${topic}.1`);
    expect(seen[0]?.ev.t).toBe('sync');
  });

  it('a sync carries the topic it is for, its messages, and the topic list', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p>x</p>' }, 'x');
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).toMatchObject({ t: 'sync', topic, messages: [{ html: '<p>x</p>' }] });
    expect((seen[0]?.ev as { topics: unknown[] }).topics).toHaveLength(1);
  });
});

describe('WebRoom: a topic older than the process', () => {
  // A transcript is memory; the topic LIST is a file. So every restart leaves rows that open
  // onto nothing, and a page that renders that faithfully looks broken rather than empty — which
  // is exactly how it was reported. The sync says which of the two it is.
  it('flags an empty room whose last activity predates this process', () => {
    const store = new TopicStore(path.join(dir, 'stale.json'));
    const old = store.create('from before');
    // Persisted by a daemon that is now gone; this WebRoom is built after it.
    store.touch(old.id, Date.now() - 60_000);
    const room = new WebRoom(instance(), store);

    const seen: Seen[] = [];
    room.subscribe(old.id, (id, ev) => seen.push({ id, ev }));

    expect(seen[0]?.ev).toMatchObject({ t: 'sync', topic: old.id, messages: [], stale: true });
  });

  it('says nothing about a topic that is merely new, or one that has something in it', () => {
    const { room, topic } = attached();
    const fresh: Seen[] = [];
    room.subscribe(topic, (id, ev) => fresh.push({ id, ev }));
    // Created by this process, so its emptiness needs no explaining — and explaining a restart
    // here would be the first thing a new install ever read.
    expect(fresh[0]?.ev).not.toHaveProperty('stale');

    const store = new TopicStore(path.join(dir, 'spoken.json'));
    const old = store.create('from before');
    store.touch(old.id, Date.now() - 60_000);
    const reopened = new WebRoom(instance(), store);
    reopened.post(old.id, { own: false, html: '<p>said since</p>' }, 'said since');
    const seen: Seen[] = [];
    reopened.subscribe(old.id, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).not.toHaveProperty('stale');
  });
});

describe('WebRoom: inbound', () => {
  it('echoes the operator message and hands the daemon the SAME id', () => {
    // They must match: the daemon reacts on the inbound id (👀 / ✅), and a mismatch would
    // leave every lifecycle reaction pointing at a message the page does not hold.
    const { room, topic, seen } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ topic, text: 'hello' });
    const echoed = seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: { id: string; own: boolean } };
    expect(echoed.msg.own).toBe(true);
    expect(got[0]?.messageId).toBe(echoed.msg.id);
  });

  it('echoes what the operator typed verbatim, not as rendered markdown', () => {
    // A prompt is checked against the compose box, so the echo has to be the same characters.
    // Rendered, this list came back numbered "1." twice — the "-ce" line is not an item, so it
    // ends the first list and "2." opened a second one that renumbered from 1.
    const { room, topic, seen } = attached();
    const text = '1. sada\n- ces1\n-ce 2\n2. test3';
    room.submit({ topic, text });
    const echoed = seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: { html: string } };
    expect(echoed.msg.html).toBe(`<div class="raw">${text}</div>`);
  });

  it('escapes the operator message it does not render', () => {
    const { room, topic, seen } = attached();
    room.submit({ topic, text: '<img src=x onerror=alert(1)>' });
    const echoed = seen.filter((s) => s.ev.t === 'msg').pop()?.ev as { msg: { html: string } };
    expect(echoed.msg.html).not.toContain('<img');
    expect(echoed.msg.html).toContain('&lt;img');
  });

  it('delivers a retried send exactly once', () => {
    // The nonce is what makes the page's retry safe on a bad link: a request can be accepted
    // and still time out, and the daemon's own dedup cannot help — it keys on a message id,
    // and a retry mints a fresh one.
    const { room, topic } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    expect(room.submit({ topic, text: 'once', nonce: 'n1' })).toBe('accepted');
    expect(room.submit({ topic, text: 'once', nonce: 'n1' })).toBe('duplicate');
    expect(got).toHaveLength(1);
  });

  it('names a blank topic from the first thing said in it', () => {
    const { room, topic } = attached();
    room.submit({ topic, text: 'why is login timing out' });
    expect(room.topics.get(topic)?.title).toBe('why is login timing out');
  });

  it('turns an upload into a data: URL, the one shape the SSRF guard has a branch for', () => {
    const { room, topic } = attached();
    const got: InboundMessage[] = [];
    room.onMessage((m) => got.push(m));
    room.submit({ topic, text: '', files: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }] });
    expect(got[0]?.attachments).toEqual([
      { type: 'image', url: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png' },
    ]);
  });

  it('ignores an empty submission', () => {
    const { room, topic } = attached();
    const onMsg = vi.fn();
    room.onMessage(onMsg);
    expect(room.submit({ topic, text: '   ' })).toBe('accepted');
    expect(onMsg).not.toHaveBeenCalled();
  });

  it('forwards a click with the same conversation a message carries', () => {
    const { room, topic } = attached();
    const clicks: Array<{ conversation: unknown; buttonId: string }> = [];
    room.onButton((ev) => clicks.push(ev));
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'mdl:r:1', label: 'x' }] }, '');
    expect(room.click({ topic, messageId: msg.id, buttonId: 'mdl:r:1' })).toBe(true);
    // Identical to the message path, because `access.allowFrom` is re-checked on every menu
    // click as `<platform>:<user>` — a click carrying a different user is silently denied.
    expect(clicks[0]?.conversation).toMatchObject({ thread: topic, kind: 'direct', user: OWNER });
  });

  it('refuses a click naming a message the topic does not hold', () => {
    const { room, topic } = attached();
    const onBtn = vi.fn();
    room.onButton(onBtn);
    expect(room.click({ topic, messageId: 'nope', buttonId: 'ask:r:0' })).toBe(false);
    expect(onBtn).not.toHaveBeenCalled();
  });
});

describe('WebRoom: outbound basics', () => {
  it('accepts a message with nobody watching', () => {
    // The contract the whole adapter rests on: the ring is the conversation, the clients are a
    // fan-out of it. Failing here would fail every turn started before the page was opened.
    const store = new TopicStore(path.join(dir, 'n.json'));
    const room = new WebRoom(instance(), store);
    expect(() => room.post(store.current().id, { own: false, html: '' }, '')).not.toThrow();
  });

  it('mints ids that are unique across topics and never reused', () => {
    // Not cosmetic: the outbound pacer coalesces edits into `edit:<channel>:<messageId>`, and
    // every topic shares the one channel — ids restarting per topic would let one topic's
    // edits supersede another's.
    const store = new TopicStore(path.join(dir, 'u.json'));
    const room = new WebRoom(instance(), store);
    const a = store.create().id;
    const b = store.create().id;
    const ids = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      ids.add(room.post(a, { own: false, html: '' }, '').id);
      ids.add(room.post(b, { own: false, html: '' }, '').id);
    }
    expect(ids.size).toBe(600);
  });

  it('throws MessageNotEditableError for an id the topic no longer holds', () => {
    const { room, topic } = attached();
    expect(() => room.revise(topic, 'never-existed', 'x')).toThrow(MessageNotEditableError);
  });

  it('strips buttons when handed an empty list, which is how every menu is retired', () => {
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: 'Yes' }] }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'answered', []);
    expect((last(seen) as { msg: { buttons: unknown[] } }).msg.buttons).toEqual([]);
  });

  it('an edit carrying buttons goes out at once, unlike a text-only one', () => {
    // The page disables a button as it is clicked and re-enables it only when the message
    // repaints. Holding that repaint for the settle window leaves the control the user just
    // pressed dead in their hand — on a multi-select, for the whole 1.5s between two ticks.
    vi.useFakeTimers();
    const { room, topic, seen } = attached();
    const msg = room.post(topic, { own: false, html: '', buttons: [{ id: 'ask:r:0', label: '☐ EU' }] }, '');
    seen.length = 0;
    room.revise(topic, msg.id, 'pick some', [{ id: 'ask:r:0', label: '☑ EU' }]);
    expect(seen).toHaveLength(1);
    expect((last(seen) as { msg: { buttons: Array<{ label: string }> } }).msg.buttons).toEqual([
      { id: 'ask:r:0', label: '☑ EU' },
    ]);
  });

  it('carries reactions on the message as well as announcing them, so a reload keeps them', () => {
    const { room, topic } = attached();
    const msg = room.post(topic, { own: false, html: '' }, '');
    room.react(topic, msg.id, '👀', true);
    room.react(topic, msg.id, '✅', true);
    room.react(topic, msg.id, '👀', false);
    const seen: Seen[] = [];
    room.subscribe(topic, (id, ev) => seen.push({ id, ev }));
    expect(seen[0]?.ev).toMatchObject({ t: 'sync', messages: [{ reactions: ['✅'] }] });
  });

  it('ignores a reaction on an unknown message, and a delete of one already gone', () => {
    const { room, topic } = attached();
    expect(() => room.react(topic, 'gone', '✅', true)).not.toThrow();
    expect(() => room.remove(topic, 'gone')).not.toThrow();
  });

  it('drops a client that throws rather than letting it take the turn down', () => {
    const store = new TopicStore(path.join(dir, 'd.json'));
    const room = new WebRoom(instance(), store);
    room.subscribe(store.current().id, () => {
      throw new Error('socket is gone');
    });
    expect(() => room.post(store.current().id, { own: false, html: '' }, '')).not.toThrow();
    expect(room.watchers).toBe(0);
  });

  it('returns the markdown it was given, not the html it rendered', () => {
    const { room, topic } = attached();
    room.post(topic, { own: false, html: '<p><strong>b</strong></p>' }, '**b**');
    expect(room.history(topic, {})[0]?.content).toBe('**b**');
  });

  it('honours limit and before, per topic', () => {
    const { room, topic } = attached();
    const ids = [1, 2, 3, 4].map((n) => room.post(topic, { own: false, html: '' }, `m${n}`).id);
    expect(room.history(topic, { limit: 2 }).map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(room.history(topic, { before: ids[2] }).map((m) => m.content)).toEqual(['m1', 'm2']);
  });

  it('hands out an opaque, page-relative token for a file and resolves it back', () => {
    const { room } = attached();
    const url = room.publish('/tmp/report.pdf', 'report.pdf');
    expect(url).toMatch(/^f\/[0-9a-f]{32}$/);
    expect(url).not.toContain('tmp');
    expect(room.resolveDownload(url.slice(2))).toEqual({ path: '/tmp/report.pdf', name: 'report.pdf' });
  });
});

describe('WebRoom: which directory a topic is working in', () => {
  it('lists nothing at all when the daemon never offered a lookup', () => {
    // Every deployment that is not the daemon — the tests above, a future embedder — must keep
    // working, so the field is absent rather than empty.
    const { room, topic } = attached();
    expect(room.topicList().find((t) => t.id === topic)?.dir).toBeUndefined();
  });

  it('labels each topic with the last segment, keeping the full path for the tooltip', () => {
    const { room, topic } = attached();
    room.useWorkdirLookup((ref) => (ref.thread === topic ? '/home/user/workspace/agent-anywhere' : undefined));

    expect(room.topicList().find((t) => t.id === topic)?.dir).toEqual({
      name: 'agent-anywhere',
      path: '/home/user/workspace/agent-anywhere',
    });
  });

  it('asks the daemon at the address of the topic, not of the channel', () => {
    // The lookup crosses back into the conversation store, which separates lanes — handing it
    // the channel would give every topic the directory of whichever one happened to be first.
    const { room, topic } = attached();
    const asked: Array<string | undefined> = [];
    room.useWorkdirLookup((ref) => {
      asked.push(ref.thread);
      return '/srv/project';
    });

    room.topicList();

    expect(asked).toEqual([topic]);
  });

  it('does not ask again for every message of a streamed turn', () => {
    // topicList() is rebuilt on every post, and the lookup stats the filesystem on the other
    // side. Without the memo a long answer asks the same question once per segment.
    vi.useFakeTimers();
    const { room, topic } = attached();
    let answer = '/srv/project';
    let asked = 0;
    room.useWorkdirLookup(() => {
      asked += 1;
      return answer;
    });

    for (let i = 0; i < 20; i++) room.post(topic, { own: false, html: '' }, `m${i}`);
    expect(asked).toBe(1);

    // Which is what the staleness costs: a `/cd` is not on the sidebar yet.
    answer = '/srv/elsewhere';
    expect(room.topicList().find((t) => t.id === topic)?.dir?.name).toBe('project');

    // And what bounds it: the label cannot be wrong for longer than the TTL.
    vi.advanceTimersByTime(DIR_TTL_MS + 1);
    expect(room.topicList().find((t) => t.id === topic)?.dir?.name).toBe('elsewhere');
    expect(asked).toBe(2);
  });

  it('posts the message even when the lookup throws', () => {
    // It runs inside announceTopics, which runs inside post. A sidebar label is not worth
    // losing an answer over.
    const { room, topic, seen } = attached();
    room.useWorkdirLookup(() => {
      throw new Error('the store is gone');
    });

    expect(() => room.post(topic, { own: false, html: '<p>hi</p>' }, 'hi')).not.toThrow();
    expect(kinds(seen)).toContain('msg');
    expect(room.topicList().find((t) => t.id === topic)?.dir).toBeUndefined();
  });
});
