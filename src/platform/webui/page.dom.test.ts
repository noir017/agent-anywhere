/**
 * The inline client script, exercised in a real DOM.
 *
 * `page.test.ts` is the cheap half of testing this file: it greps the served HTML and proves the
 * script parses. That catches a stray brace and a character the template literal ate, and it
 * catches nothing else — which is how 1.15.0 shipped a page that rendered nothing at all while
 * its event stream was perfectly healthy. Every gate in this repo was green for that bug, because
 * to all of them `page.ts` is one long string.
 *
 * So this file loads what the daemon actually serves into jsdom, stubs the two things a browser
 * gives the script that Node does not (`EventSource` and `fetch`), and drives it through the
 * events `room.ts` really emits. The assertions are about what a person would see: how many
 * messages are on screen, whether the drawer is open, where the URL points.
 *
 * ── Two jsdom limits worth knowing before adding to this file ────────────────
 *   - It does not evaluate `@media` at all, so `getComputedStyle` always reports the desktop
 *     cascade. Responsive rules are therefore checked by walking `document.styleSheets`, not by
 *     resizing and reading computed values. The *script's* own narrow-screen branches do respond
 *     to `innerWidth`, and those are driven normally.
 *   - Its CSSOM keeps only the last of two declarations of one property, so a deliberate
 *     `height:100vh; height:100dvh` fallback pair reads as collapsed here while being correct in
 *     a browser. Do not "fix" the stylesheet to satisfy a serialization artifact.
 *
 * `EventSource` is installed in `beforeParse`, before the script runs, deliberately: evaluating
 * the script a second time to give it a stubbed global would register every listener twice and
 * fire every click handler twice. `indexedDB` — which jsdom does not implement at all — goes in
 * the same way, as a `fake-indexeddb` factory the harness can hand to a SECOND page so a reload,
 * or a daemon restart under a page that is still open, can be driven end to end.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

import { renderPage } from './page.js';

/** One `fetch` the page made, in the shape the assertions care about. */
interface Call {
  path: string;
  body: Record<string, unknown>;
}

/** The stub for the one browser API the whole page is built on. */
interface Stream {
  url: string;
  readyState: number;
  closed: boolean;
  onmessage: ((e: { data: string }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
}

interface Harness {
  window: DOMWindow;
  doc: Document;
  /** Every stream the page has opened, oldest first — switching topics opens another. */
  streams: Stream[];
  /** The one currently connected. */
  live: () => Stream;
  /** Deliver a server event down the live stream, as `api/events` would. */
  emit: (ev: Record<string, unknown>) => Promise<void>;
  calls: Call[];
  /** Mutable per-path HTTP status, so a send can be made to fail (and then succeed) mid-test. */
  status: Record<string, number>;
  /** The page's own database, to hand to a second page or to read back. */
  idb: IDBFactory | null;
  /** What this browser has cached for a topic, as the page would read it back. */
  cached: (topic: string) => Promise<Array<Record<string, unknown>> | null>;
  /** Everything written to `navigator.clipboard` by the page. */
  clipboard: string[];
  el: (id: string) => HTMLElement;
  /** Messages currently painted in the transcript. */
  painted: () => number;
  /** Placeholder blocks held in the transcript while a sync is in flight. */
  skeletons: () => number;
  /** Topic rows currently painted in the sidebar. */
  rows: () => number;
  /** The "why is this room empty" notice, when one is on screen. */
  notice: () => string | null;
  click: (selector: string) => Promise<void>;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Long enough for the page's write debounce (SAVE_MS) to have fired and the write to land. */
const saved = (): Promise<void> => new Promise((r) => setTimeout(r, 550));

/**
 * Spin the macrotask queue until something becomes true.
 *
 * `FileReader` resolves over several turns in jsdom, and how many is an implementation detail —
 * a fixed number of `tick()`s here would be a test that passes until jsdom changes its mind. The
 * cache read on the way into a topic is the same shape of wait, one IndexedDB turn instead.
 */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (ok()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

/** The same wait, for a condition that is itself a database read. */
async function untilAsync(what: string, ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await ok()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

/** A sync in the shape `WebRoom.syncEvent` builds it. `extra` carries the optional flags. */
function sync(
  topic: string,
  messages: Array<Record<string, unknown>>,
  topics: string[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    t: 'sync',
    topic,
    messages,
    commands: [{ name: 'new', description: 'start over' }],
    // One daemon, unless a test is specifically about a restart. Ids are per process, so this is
    // what keeps a cached `w1` and a fresh `w1` from being taken for the same message.
    epoch: 1,
    topics: topics.map((id, i) => ({
      id,
      title: `Topic ${id}`,
      lastAt: 1000 - i,
      running: false,
      msgCount: id === topic ? messages.length : 0,
    })),
    ...extra,
  };
}

function message(id: string, html: string, own = false): Record<string, unknown> {
  return { id, html, at: 1758240000000, own };
}

async function open(
  opts: {
    url?: string;
    width?: number;
    height?: number;
    /** What each POST answers with; anything unlisted answers `{}`, as most routes do. */
    replies?: Record<string, unknown>;
    /** Per-path HTTP status. Anything unlisted answers 200; ≥400 is `ok: false`. */
    status?: Record<string, number>;
    /**
     * The database this page opens. Pass a previous harness's to reload the same browser;
     * pass `null` for one that has no IndexedDB at all, which is a real browser configuration
     * and must not take the page down with it.
     */
    idb?: IDBFactory | null;
    /** What `confirm()` returns — a destructive control is only half tested by the yes path. */
    confirm?: boolean;
  } = {}
): Promise<Harness> {
  const {
    url = 'http://localhost:8787/',
    width = 1440,
    height = 900,
    replies = {},
    status = {},
    idb = new IDBFactory(),
    confirm = true,
  } = opts;
  const streams: Stream[] = [];
  const calls: Call[] = [];
  const clipboard: string[] = [];

  const dom = new JSDOM(renderPage('Chat'), {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
      Object.defineProperty(w, 'innerHeight', { value: height, configurable: true });
      if (idb) (w as any).indexedDB = idb;
      Object.defineProperty(w.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (s: string) => {
            clipboard.push(s);
            return Promise.resolve();
          },
        },
      });
      class FakeEventSource implements Stream {
        readyState = 1;
        closed = false;
        onmessage: ((e: { data: string }) => void) | null = null;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(readonly url: string) {
          streams.push(this);
          // The script assigns onopen after constructing, so this cannot be synchronous.
          setTimeout(() => this.onopen?.(), 0);
        }
        close(): void {
          this.readyState = 2;
          this.closed = true;
        }
      }
      (w as any).EventSource = FakeEventSource;
      (w as any).confirm = () => confirm;
      (w as any).fetch = (path: string, init: { body: string }) => {
        calls.push({ path, body: JSON.parse(init.body) });
        const code = status[path] ?? 200;
        return Promise.resolve({
          ok: code < 400,
          status: code,
          json: () => Promise.resolve(replies[path] ?? {}),
        });
      };
    },
  });

  await tick();
  const doc = dom.window.document;
  const live = (): Stream => {
    const open = streams.filter((s) => !s.closed);
    const last = open[open.length - 1];
    if (!last) throw new Error('no stream is connected');
    return last;
  };
  return {
    window: dom.window,
    doc,
    streams,
    live,
    calls,
    status,
    idb,
    clipboard,
    cached: (topic) => readCache(idb, topic),
    emit: async (ev) => {
      live().onmessage?.({ data: JSON.stringify(ev) });
      await tick();
    },
    el: (id) => {
      const found = doc.getElementById(id);
      if (!found) throw new Error(`#${id} is not in the document`);
      return found;
    },
    painted: () => doc.getElementById('log')!.querySelectorAll(':scope > .m').length,
    skeletons: () => doc.getElementById('log')!.querySelectorAll(':scope > .sk').length,
    rows: () => doc.getElementById('topics')!.children.length,
    notice: () => doc.querySelector('#log > .empty')?.textContent ?? null,
    click: async (selector) => {
      const target = doc.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`nothing matches ${selector}`);
      target.click();
      await tick();
    },
  };
}

/**
 * Read one topic's cached transcript straight out of the database.
 *
 * Deliberately not through the page: what is asserted is what a RELOAD would find, so it is read
 * the way the next page would read it rather than the way this one remembers writing it.
 */
function readCache(idb: IDBFactory | null, topic: string): Promise<Array<Record<string, unknown>> | null> {
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rq = idb.open('aa_cache', 1);
    rq.onerror = () => resolve(null);
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('topics')) {
        db.close();
        return resolve(null);
      }
      const get = db.transaction('topics').objectStore('topics').get(topic);
      get.onerror = () => {
        db.close();
        resolve(null);
      };
      get.onsuccess = () => {
        const rec = get.result as { json?: string } | undefined;
        db.close();
        resolve(rec?.json ? (JSON.parse(rec.json) as Array<Record<string, unknown>>) : null);
      };
    };
  });
}

describe('webui page: rendering', () => {
  it('renders the sync for a topic the client never named', async () => {
    // The 1.15.0 regression, and the reason this file exists. A first visit has no ?t=, so the
    // client's topic is '' and `stream()` answers for `topics.current()` — a sync carrying an id
    // the page never asked for. Dropping it left an empty shell behind a healthy event stream.
    const h = await open({ url: 'http://localhost:8787/' });
    expect(h.live().url).toBe('api/events');

    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>'), message('m2', '<p>hi</p>', true)], ['a1b2c3d4']));

    expect(h.painted()).toBe(2);
    expect(h.el('log').textContent).toContain('hello');
    expect(h.rows()).toBe(1);
    expect(h.el('topic-title').textContent).toBe('Topic a1b2c3d4');
    // Written into the URL, so the reload after it lands in the same room.
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
  });

  it('shows an operator message as typed, numbers and line breaks intact', async () => {
    // The bug this is here for: rendered as markdown, "-ce 2" ends the first list and "2." opens
    // a second one that renumbers from 1, so a prompt written 1./2. read back 1./1. `room.ts`
    // now sends the text escaped rather than rendered — this checks the page shows it that way,
    // which is the half of the fix a server-side test cannot see.
    const h = await open();
    const typed = '1. sada\n- ces1\n-ce 2\n2. test3';
    await h.emit(sync('a1b2c3d4', [message('m1', `<div class="raw">${typed}</div>`, true)], ['a1b2c3d4']));

    expect(h.painted()).toBe(1);
    expect(h.el('log').querySelector('ol')).toBeNull();
    expect(h.el('log').querySelector('.raw')?.textContent).toBe(typed);
  });

  it('still ignores a sync for a topic it has already left', async () => {
    // The guard the regression came from is real, just misaimed: once we ARE on a topic, a sync
    // for another one is a stale stream talking and must not repaint the transcript.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>mine</p>')], ['a1b2c3d4']));
    expect(h.painted()).toBe(1);

    await h.emit(sync('ffffffff', [message('x1', '<p>someone else</p>'), message('x2', '<p>and more</p>')], ['ffffffff']));

    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).toContain('mine');
    expect(h.el('log').textContent).not.toContain('someone else');
  });

  it('appends, edits, drops and reacts as the events arrive', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>')], ['a1b2c3d4']));

    await h.emit({ t: 'msg', msg: message('m2', '<p>second</p>') });
    expect(h.painted()).toBe(2);

    // Same id is an edit in place, which is the whole streaming model: one live-edited message.
    await h.emit({ t: 'msg', msg: message('m2', '<p>second, revised</p>') });
    expect(h.painted()).toBe(2);
    expect(h.el('log').textContent).toContain('second, revised');

    await h.emit({ t: 'react', id: 'm2', emoji: '👍', on: true });
    expect(h.el('log').textContent).toContain('👍');

    await h.emit({ t: 'del', id: 'm2' });
    expect(h.painted()).toBe(1);
    expect(h.el('log').textContent).not.toContain('second');
  });

  it('a sync reuses the elements already on screen instead of rebuilding the transcript', async () => {
    // Entering a topic used to empty #log and repaint everything, which destroyed the scroll
    // container along with its position and flashed through blank even when the messages were
    // already there from cache. Node identity is the observable half of that: if these are the
    // same elements afterwards, nothing was rebuilt and nothing re-ran the fade-in.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>')], ['a1b2c3d4']));
    const before = [...h.el('log').children];
    expect(before).toHaveLength(2);

    // A reconnect replays the same conversation with one more message on the end.
    await h.emit(
      sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>'), message('m3', '<p>third</p>')], ['a1b2c3d4'])
    );
    const after = [...h.el('log').children];
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('a sync drops what the server no longer has, and reorders without re-creating', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>')], ['a1b2c3d4']));
    const kept = h.el('log').children[1];

    // m1 aged out of the server's ring; m2 survives and is now the only thing in the topic.
    await h.emit(sync('a1b2c3d4', [message('m2', '<p>second</p>')], ['a1b2c3d4']));
    expect(h.painted()).toBe(1);
    expect(h.el('log').children[0]).toBe(kept);
    expect(h.el('log').textContent).not.toContain('first');
  });

  it('holds the shape of the transcript until the first sync lands, then gives the space back', async () => {
    const h = await open();
    // Nothing has been synced yet: the page is waiting on its very first payload.
    expect(h.skeletons()).toBeGreaterThan(0);
    expect(h.painted()).toBe(0);

    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>')], ['a1b2c3d4']));
    expect(h.skeletons()).toBe(0);
    expect(h.painted()).toBe(1);
  });

  it('a reconnect with the conversation still on screen shows no placeholders', async () => {
    // The skeleton answers "there is nothing here yet", not "the socket went away". Replacing a
    // transcript someone is reading with grey bars every time the stream blips would be worse
    // than the blank panel this replaced.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>')], ['a1b2c3d4']));
    h.live().onerror?.();
    expect(h.skeletons()).toBe(0);
    expect(h.painted()).toBe(1);
  });

  it('marks your own messages apart from the agent', async () => {
    // The only thing that separates the two sides of the transcript is this class, and the
    // stylesheet hangs a tinted panel off it. Painted onto the wrong side — or onto neither —
    // a long conversation is one undifferentiated column again.
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [message('m1', '<p>the answer</p>'), message('m2', '<p>the question</p>', true)], ['a1b2c3d4'])
    );

    const painted = Array.from(h.el('log').children);
    expect(painted.map((el) => el.className)).toEqual(['m', 'm own']);
  });

  it('shows the typing indicator and marks the topic running', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    expect(h.el('typing').hidden).toBe(true);

    await h.emit({ t: 'typing', on: true });
    expect(h.el('typing').hidden).toBe(false);
    expect(h.doc.querySelector('.topic-item')?.className).toContain('running');

    await h.emit({ t: 'typing', on: false });
    expect(h.el('typing').hidden).toBe(true);
  });
});

describe('webui page: topics', () => {
  it('paints a switched-to topic from cache before its stream has answered', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>'), message('m2', '<p>also A</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.painted()).toBe(2);

    await h.click('[data-topic="b2c3d4e5"]');
    // Nothing cached for B yet and its stream has said nothing — so what is on screen is the
    // shape of a transcript rather than either an empty panel or a message.
    expect(h.painted()).toBe(0);
    expect(h.skeletons()).toBeGreaterThan(0);
    expect(h.live().url).toBe('api/events?t=b2c3d4e5');

    await h.click('[data-topic="a1b2c3d4"]');
    // A came back with no sync emitted at all — this is the cache, and the point of it. It is
    // read rather than remembered, so it arrives an IndexedDB turn later than the click.
    await until('A is painted from cache', () => h.painted() === 2);
    expect(h.el('log').textContent).toContain('in A');
    expect(h.window.location.search).toBe('?t=a1b2c3d4');
  });

  it('closes the stream it left behind when switching', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    const first = h.live();

    await h.click('[data-topic="b2c3d4e5"]');

    expect(first.closed).toBe(true);
    expect(h.streams.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('asks the daemon to delete a topic and stops showing it', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));

    await h.click('[data-del="b2c3d4e5"]');

    expect(h.calls.map((c) => c.path)).toContain('api/topics/delete');
    expect(h.calls.find((c) => c.path === 'api/topics/delete')?.body).toEqual({ topic: 'b2c3d4e5' });

    // The server answers by announcing the list again; the sidebar follows it, not the click.
    await h.emit({ t: 'topics', topics: [{ id: 'a1b2c3d4', title: 'Topic a1b2c3d4', lastAt: 1000, msgCount: 0 }] });
    expect(h.rows()).toBe(1);
  });

  it('shows which project each topic is working in', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'fix the parser', lastAt: 1000, msgCount: 0, dir: { name: 'agent-anywhere', path: '/home/user/workspace/agent-anywhere' } },
        { id: 'b2c3d4e5', title: 'bump the image', lastAt: 999, msgCount: 0, dir: { name: 'uniagent', path: '/home/user/workspace/uniagent' } },
      ],
    });

    const dirs = Array.from(h.doc.querySelectorAll('.topic-dir'));
    expect(dirs.map((d) => d.textContent)).toEqual(['agent-anywhere', 'uniagent']);
    // The column is 240px wide, so the row shows the last segment and the tooltip carries the
    // path that tells two checkouts of one project apart.
    expect(dirs[0]!.getAttribute('title')).toBe('/home/user/workspace/agent-anywhere');
  });

  it('leaves the row alone for a daemon that offered no directory', async () => {
    // Every `topics` event before this feature existed, and every deployment whose adapter does
    // not implement the lookup: the second line is absent, not blank.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    expect(h.doc.querySelector('.topic-dir')).toBeNull();
    expect(h.doc.querySelector('.topic-title')?.textContent).toBe('Topic a1b2c3d4');
  });

  it('survives a directory name with a quote in it', async () => {
    // The path goes into a title attribute, and textContent-based escaping leaves the quote
    // alone — so an unescaped one ends the attribute and spills the rest of the path into the
    // tag. Legal on every filesystem this runs on, and the row is unreadable when it happens.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.emit({
      t: 'topics',
      topics: [{ id: 'a1b2c3d4', title: 'odd', lastAt: 1, msgCount: 0, dir: { name: 'say "hi"', path: '/tmp/say "hi"' } }],
    });

    const dir = h.doc.querySelector('.topic-dir');
    expect(dir?.textContent).toBe('say "hi"');
    expect(dir?.getAttribute('title')).toBe('/tmp/say "hi"');
    // Nothing leaked out of the attribute and became markup.
    expect(h.el('topics').querySelectorAll('.topic-dir')).toHaveLength(1);
  });

  it('badges unread messages on a topic that is not the one being read', async () => {    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.doc.querySelector('.topic-badge')).toBeNull();

    await h.emit({
      t: 'topics',
      topics: [
        { id: 'a1b2c3d4', title: 'Topic a1b2c3d4', lastAt: 1000, msgCount: 0 },
        { id: 'b2c3d4e5', title: 'Topic b2c3d4e5', lastAt: 999, msgCount: 3 },
      ],
    });

    expect(h.doc.querySelector('.topic-badge')?.textContent).toBe('3');
  });

  it('sweeps every topic away and lands in the one that replaced them', async () => {
    const h = await open({ replies: { 'api/topics/clear': { topic: { id: 'deadbeef', title: '', lastAt: 2000 } } } });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>')], ['a1b2c3d4', 'b2c3d4e5']));
    expect(h.painted()).toBe(1);
    await saved();
    expect(await h.cached('a1b2c3d4')).toHaveLength(1);

    await h.click('#clear-topics');

    expect(h.calls.find((c) => c.path === 'api/topics/clear')?.body).toEqual({});
    // Landed in the replacement rather than waiting for the broadcast list to say where to go.
    expect(h.live().url).toBe('api/events?t=deadbeef');
    expect(h.window.location.search).toBe('?t=deadbeef');
    expect(h.painted()).toBe(0);
    expect(h.rows()).toBe(1);
    // Every local record of the old rooms went with them: a cache left behind would repaint
    // messages for ids the daemon has forgotten the moment one of them was opened again, and a
    // read mark left behind would badge the replacement against a count from a dead room.
    await untilAsync('the cached transcript is gone', async () => (await h.cached('a1b2c3d4')) === null);
    expect(await h.cached('a1b2c3d4')).toBeNull();
    expect(JSON.parse(h.window.localStorage.getItem('aa_reads') ?? 'null')).toEqual({ deadbeef: 0 });
  });

  it('does nothing at all when the confirmation is declined', async () => {
    const h = await open({ confirm: false });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>in A</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    await h.click('#clear-topics');

    expect(h.calls.map((c) => c.path)).not.toContain('api/topics/clear');
    expect(h.rows()).toBe(2);
    expect(h.painted()).toBe(1);
  });
});

describe('webui page: a topic the daemon no longer has', () => {
  // A transcript lives in the daemon's memory while the topic LIST lives on disk, so every
  // restart leaves rows that open onto nothing. Rendered faithfully that is a blank panel — which
  // is indistinguishable from a page that failed to load, and is how it was reported.
  it('says why an emptied topic is empty', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true }));

    expect(h.painted()).toBe(0);
    expect(h.skeletons()).toBe(0);
    expect(h.notice()).toContain('older than the running daemon');
    // The half that keeps it from reading as data loss: the agent's own context is persisted.
    expect(h.notice()).toContain('still has its context');
  });

  it('takes the notice away as soon as the topic has something in it', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { stale: true }));
    expect(h.notice()).not.toBeNull();

    await h.emit({ t: 'msg', msg: message('m1', '<p>carrying on</p>') });

    expect(h.notice()).toBeNull();
    expect(h.painted()).toBe(1);
  });

  it('leaves a genuinely new topic to speak for itself', async () => {
    // No flag, so this room is empty because nothing has been said in it yet. Explaining a
    // restart here would be both wrong and the first thing a new install ever reads.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    expect(h.notice()).toBeNull();
  });

  it('does not carry the notice into the next topic', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5'], { stale: true }));
    expect(h.notice()).not.toBeNull();

    await h.click('[data-topic="b2c3d4e5"]');

    // Whether THAT room predates the daemon is its own sync's answer to give; until it lands the
    // page is back to showing the shape of a transcript that is on its way.
    expect(h.notice()).toBeNull();
    expect(h.skeletons()).toBeGreaterThan(0);
  });
});

describe('webui page: sending', () => {
  it('posts a button click back with the message and button it belongs to', async () => {
    const h = await open();
    await h.emit(
      sync('a1b2c3d4', [{ ...message('m1', '<p>pick one</p>'), buttons: [{ id: 'b:yes', label: 'Yes' }] }], ['a1b2c3d4'])
    );

    await h.click('button[data-btn="b:yes"]');

    expect(h.calls.find((c) => c.path === 'api/click')?.body).toEqual({
      topic: 'a1b2c3d4',
      messageId: 'm1',
      buttonId: 'b:yes',
    });
    // Disabled on click, so a slow link cannot be answered twice.
    expect(h.doc.querySelector<HTMLButtonElement>('button[data-btn="b:yes"]')?.disabled).toBe(true);
  });

  it('a repaint hands the button back, which is what makes a multi-select tickable twice', async () => {
    // The click handler disables and never re-enables; the repaint that follows the tap is what
    // does. A multi-select round rests entirely on this — tick, untick, tick again all land on the
    // same button — so it is pinned here rather than left as a property of innerHTML.
    const h = await open();
    const ticked = { ...message('m1', '<p>pick some</p>'), buttons: [{ id: 'ask:r:0', label: '☐ EU' }] };
    await h.emit(sync('a1b2c3d4', [ticked], ['a1b2c3d4']));

    await h.click('button[data-btn="ask:r:0"]');
    expect(h.doc.querySelector<HTMLButtonElement>('button[data-btn="ask:r:0"]')?.disabled).toBe(true);

    await h.emit({ t: 'msg', msg: { ...ticked, buttons: [{ id: 'ask:r:0', label: '☑ EU' }] } });
    const button = h.doc.querySelector<HTMLButtonElement>('button[data-btn="ask:r:0"]');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe('☑ EU');
  });

  it('sends with a nonce and clears the composer', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = 'hello there';

    await h.click('#composer button[type="submit"]');

    const sent = h.calls.find((c) => c.path === 'api/send');
    expect(sent?.body.text).toBe('hello there');
    expect(sent?.body.topic).toBe('a1b2c3d4');
    // Without it the page's own retry would post the same message twice.
    expect(typeof sent?.body.nonce).toBe('string');
    expect(input.value).toBe('');
  });

  /**
   * Enter in the composer, as a browser delivers it. `win.KeyboardEvent` rather than the global
   * one: the event has to come from the same realm as the listener, or jsdom's `instanceof`
   * checks inside the dispatch path disagree about what it is.
   */
  const pressEnter = async (h: Harness, mods: KeyboardEventInit = {}): Promise<void> => {
    const win = h.doc.defaultView as Window & typeof globalThis;
    h.el('input').dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...mods }),
    );
    await tick();
  };

  it('leaves a plain Enter to write a newline instead of sending', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    const input = h.el('input') as HTMLTextAreaElement;
    input.value = 'first line';

    await pressEnter(h);

    // Nothing sent, and the keystroke was not swallowed — jsdom does not insert the newline
    // itself, so the default being left alone is the whole of what "writes a newline" means here.
    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
    expect(input.value).toBe('first line');
  });

  it('sends on Ctrl-Enter and on Cmd-Enter', async () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      const h = await open();
      await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
      (h.el('input') as HTMLTextAreaElement).value = 'ship it';

      await pressEnter(h, mods);

      expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('ship it');
    }
  });

  it('ignores Enter mid-composition, which is a candidate being chosen and not a send', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = '你好';

    await pressEnter(h, { ctrlKey: true, isComposing: true } as KeyboardEventInit);

    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
  });

  it('refuses to send nothing', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = '   ';

    await h.click('#composer button[type="submit"]');

    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
  });

  it('shows the message as soon as it is typed, before the request is answered', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'ship it';

    // Clicked WITHOUT awaiting: the assertion is that the bubble is there before the fetch has
    // resolved, which is the whole of this feature.
    h.doc.querySelector<HTMLElement>('#composer button[type="submit"]')!.click();

    expect(h.painted()).toBe(1);
    const bubble = h.el('log').querySelector('.m');
    expect(bubble?.className).toContain('own');
    expect(bubble?.className).toContain('pending');
    expect(bubble?.textContent).toContain('ship it');

    await tick();
    // Answered: still one message, and no longer dimmed as in flight.
    expect(h.painted()).toBe(1);
    expect(h.el('log').querySelector('.m')?.className).not.toContain('pending');
  });

  it('lets the echo take over the local bubble rather than doubling it', async () => {
    // The node identity is the assertion. Removing the local bubble and painting the server's
    // copy would re-run the fade-in and move the scroll, for a message that has been on screen
    // since it was typed.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'ship it';
    await h.click('#composer button[type="submit"]');
    const before = h.el('log').children[0];
    const nonce = h.calls.find((c) => c.path === 'api/send')?.body.nonce as string;

    await h.emit({ t: 'msg', msg: { ...message('w1', '<div class="raw">ship it</div>', true), nonce } });

    expect(h.painted()).toBe(1);
    expect(h.el('log').children[0]).toBe(before);
    expect(h.el('log').textContent).toContain('ship it');
  });

  it('keeps a message that did not reach the daemon, with something to do about it', async () => {
    // What used to happen instead: the composer was cleared, the POST failed, and a line of note
    // text was all that was left of the prompt. The text IS the message here.
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'a prompt worth not retyping';

    await h.click('#composer button[type="submit"]');

    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);
    expect(h.el('log').textContent).toContain('a prompt worth not retyping');
    expect(h.el('log').textContent).toContain('Not delivered');
    expect(h.doc.querySelector('[data-retry]')).not.toBeNull();
    expect(h.doc.querySelector('[data-copy]')).not.toBeNull();
    expect(h.doc.querySelector('[data-discard]')).not.toBeNull();
  });

  it('retries under the original nonce, so a request that did land cannot double', async () => {
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'try again';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);

    h.status['api/send'] = 200;
    await h.click('[data-retry]');

    const sends = h.calls.filter((c) => c.path === 'api/send');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body.nonce).toBe(sends[0]?.body.nonce);
    expect(h.doc.querySelector('.m.failed')).toBeNull();
  });

  it('copies the text of a failed message, and forgets one that is discarded', async () => {
    const h = await open({ status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'the prompt itself';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);

    await h.click('[data-copy]');
    expect(h.clipboard).toEqual(['the prompt itself']);
    expect(h.doc.querySelector('[data-copy]')?.textContent).toBe('Copied');

    await h.click('[data-discard]');
    expect(h.painted()).toBe(0);
  });

  it('keeps a failed message across a reload, offering what it can still honour', async () => {
    // The body it would be retried with holds its attachments as base64 and is deliberately not
    // written to the cache, so the reloaded page offers Copy and Discard and does not pretend it
    // can re-send something it no longer has.
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', status: { 'api/send': 400 } });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = 'do not lose this';
    await h.click('#composer button[type="submit"]');
    await until('the failure is drawn', () => h.doc.querySelector('.m.failed') !== null);
    await saved();

    const again = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: h.idb });

    await until('the failure is restored', () => again.doc.querySelector('.m.failed') !== null);
    expect(again.el('log').textContent).toContain('do not lose this');
    expect(again.doc.querySelector('[data-retry]')).toBeNull();
    expect(again.doc.querySelector('[data-copy]')).not.toBeNull();
    expect(again.doc.querySelector('[data-discard]')).not.toBeNull();
  });
});

describe('webui page: the local transcript cache', () => {
  it('paints a topic from the last visit before the daemon has said anything', async () => {
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>first</p>'), message('m2', '<p>second</p>')], ['a1b2c3d4']));
    await saved();
    expect(await h.cached('a1b2c3d4')).toHaveLength(2);

    // A different page object on the same browser: everything in memory is gone, the database is
    // not. Nothing is emitted down this one's stream at all.
    const again = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: h.idb });

    await until('the cached transcript is painted', () => again.painted() === 2);
    expect(again.el('log').textContent).toContain('first');
    expect(again.skeletons()).toBe(0);
  });

  it('keeps what a restarted daemon has lost, says so, and leaves nothing to click', async () => {
    const withButton = { ...message('m2', '<p>pick one</p>'), buttons: [{ id: 'b:yes', label: 'Yes' }] };
    const first = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await first.emit(sync('a1b2c3d4', [message('m1', '<p>from before</p>'), withButton], ['a1b2c3d4']));
    await saved();

    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: first.idb });
    await until('the cached transcript is painted', () => h.painted() === 2);

    // The daemon came back: a new generation, an empty ring, and a topic older than the process.
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { epoch: 2, stale: true }));

    expect(h.painted()).toBe(2);
    expect(h.doc.querySelectorAll('#log > .m.hist')).toHaveLength(2);
    expect(h.doc.querySelector('#log > .divider')?.textContent).toContain('before the daemon restarted');
    // The apology is for a room with nothing in it; there is something in this one.
    expect(h.notice()).toBeNull();
    // The process that would answer that button is gone, and the id it names now means nothing.
    expect(h.doc.querySelector('button[data-btn]')).toBeNull();
  });

  it('does not let a restarted daemon reuse an id over a cached message', async () => {
    // Ids are counted per process and start again at w1, so a cached message and a fresh one can
    // both be called m1. Keyed by id alone the reply overwrites the history; keyed by generation
    // they are two messages, which is what they are.
    const first = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });
    await first.emit(sync('a1b2c3d4', [message('m1', '<p>from before</p>')], ['a1b2c3d4']));
    await saved();

    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4', idb: first.idb });
    await until('the cached transcript is painted', () => h.painted() === 1);
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4'], { epoch: 2, stale: true }));

    await h.emit({ t: 'msg', msg: message('m1', '<p>brand new</p>') });

    expect(h.painted()).toBe(2);
    expect(h.el('log').textContent).toContain('from before');
    expect(h.el('log').textContent).toContain('brand new');
  });

  it('keeps only the tail of a long topic', async () => {
    const many: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 210; i++) many.push(message(`m${i}`, `<p>line ${i}</p>`));
    const h = await open({ url: 'http://localhost:8787/?t=a1b2c3d4' });

    await h.emit(sync('a1b2c3d4', many, ['a1b2c3d4']));
    await saved();

    const kept = await h.cached('a1b2c3d4');
    expect(kept).toHaveLength(200);
    expect(kept?.[0]?.id).toBe('m10');
    expect(kept?.[199]?.id).toBe('m209');
  });

  it('works on a browser with no IndexedDB at all', async () => {
    // Private windows and old engines both produce one. The cache is the only thing that goes.
    const h = await open({ idb: null });

    await h.emit(sync('a1b2c3d4', [message('m1', '<p>still here</p>')], ['a1b2c3d4']));
    expect(h.painted()).toBe(1);

    (h.el('input') as HTMLTextAreaElement).value = 'and sending still works';
    await h.click('#composer button[type="submit"]');
    expect(h.painted()).toBe(2);
    expect(h.calls.find((c) => c.path === 'api/send')?.body.text).toBe('and sending still works');
  });
});

describe('webui page: pasting', () => {
  /**
   * A `paste` carrying clipboard items.
   *
   * jsdom implements neither `ClipboardEvent` nor `DataTransfer`, so the event is an ordinary
   * one with `clipboardData` defined onto it — which is all the handler reads, and keeps this
   * about the handler rather than about jsdom's coverage of the clipboard API.
   */
  function pasteOf(h: Harness, items: Array<{ kind: string; type: string; file: File | null }>): Event {
    const ev = new h.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: items.map((i) => ({ kind: i.kind, type: i.type, getAsFile: () => i.file })) },
    });
    return ev;
  }

  const image = (h: Harness, name: string, type: string): File =>
    new h.window.File([new Uint8Array([137, 80, 78, 71])], name, { type });

  it('attaches a screenshot pasted into the composer', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    const ev = pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]);
    h.el('input').dispatchEvent(ev);

    // Swallowed, or the `<img>` the clipboard carries beside the file pastes into the textarea
    // as markup on top of the attachment.
    expect(ev.defaultPrevented).toBe(true);
    await until('the chip is rendered', () => h.el('chips').textContent !== '');
    expect(h.el('chips').textContent).toBe('pasted-1.png');

    (h.el('input') as HTMLTextAreaElement).value = 'what is this';
    await h.click('#composer button[type="submit"]');

    const sent = h.calls.find((c) => c.path === 'api/send');
    const files = sent?.body.files as Array<Record<string, string>>;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('pasted-1.png');
    expect(files[0]!.mime).toBe('image/png');
    // Base64 with the `data:` prefix cut off, which is what `api/send` accepts.
    expect(files[0]!.data).toBe('iVBORw==');
  });

  it('gives each paste a name of its own', async () => {
    // Every engine calls a pasted screenshot image.png, so without this two of them are two
    // indistinguishable chips and two attachments the agent cannot tell apart.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    h.el('input').dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]));
    await until('the first chip', () => h.el('chips').children.length === 1);
    h.el('input').dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/jpeg', file: image(h, 'image.png', 'image/jpeg') }]));
    await until('the second chip', () => h.el('chips').children.length === 2);

    expect(Array.from(h.el('chips').children).map((c) => c.textContent)).toEqual(['pasted-1.png', 'pasted-2.jpeg']);
  });

  it('leaves an ordinary text paste alone', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    const ev = pasteOf(h, [{ kind: 'string', type: 'text/plain', file: null }]);
    h.el('input').dispatchEvent(ev);

    // Cancelling this one would mean pasting text into the composer no longer works at all.
    expect(ev.defaultPrevented).toBe(false);
    await tick();
    expect(h.el('chips').textContent).toBe('');
  });

  it('takes a paste that landed outside the composer', async () => {
    // The textarea is not focused after clicking a topic or a button, and on a phone it is
    // rarely focused at all — a paste that reaches nothing there looks like a broken feature.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    h.doc.body.dispatchEvent(pasteOf(h, [{ kind: 'file', type: 'image/png', file: image(h, 'image.png', 'image/png') }]));

    await until('the chip is rendered', () => h.el('chips').textContent !== '');
    expect(h.el('chips').textContent).toBe('pasted-1.png');
  });
});

describe('webui page: the file picker', () => {
  /**
   * Pick files through the `+` button.
   *
   * jsdom has no FileList and will not let one be assigned to `picker.files`, so the property is
   * redefined — configurable, because the handler sets `picker.value=''` afterwards and jsdom
   * routes that through the same internal file list.
   */
  const pick = (h: Harness, files: File[]): void => {
    const picker = h.el('picker');
    Object.defineProperty(picker, 'files', { value: files, configurable: true, writable: true });
    picker.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };

  it('takes a document as readily as an image', async () => {
    // The picker carries no `accept`, so the browser offers every file — and nothing downstream
    // narrows that either: `mime.startsWith('image/')` in room.ts only chooses between the
    // `image` and `file` attachment kinds, it does not reject the second one.
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    pick(h, [
      new h.window.File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }),
      // Empty type is what a browser reports for an extension it does not recognise.
      new h.window.File(['zipbytes'], 'logs.tar.zst', { type: '' }),
    ]);

    await until('both chips are rendered', () => h.el('chips').children.length === 2);
    expect(Array.from(h.el('chips').children).map((c) => c.textContent)).toEqual([
      'report.pdf',
      'logs.tar.zst',
    ]);

    (h.el('input') as HTMLTextAreaElement).value = 'read these';
    await h.click('#composer button[type="submit"]');

    const files = h.calls.find((c) => c.path === 'api/send')?.body.files as Array<Record<string, string>>;
    expect(files.map((f) => [f.name, f.mime])).toEqual([
      ['report.pdf', 'application/pdf'],
      ['logs.tar.zst', ''],
    ]);
  });
});

describe('webui page: a screen held upright', () => {
  it('starts with the drawer shut and the keyboard down', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [message('m1', '<p>hello</p>')], ['a1b2c3d4', 'b2c3d4e5']));

    expect(h.el('sidebar').className).toBe('collapsed');
    expect(h.el('backdrop').hidden).toBe(true);
    expect(h.el('expand-sidebar').hidden).toBe(false);
    // Focusing on open would put the keyboard over half a portrait viewport before a word of
    // the conversation had been read.
    expect(h.doc.activeElement).not.toBe(h.el('input'));
    // The chat is still rendered underneath — the drawer is not the landing screen.
    expect(h.painted()).toBe(1);
  });

  it('opens the drawer with a backdrop, and the backdrop shuts it', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));

    await h.click('#expand-sidebar');
    expect(h.el('sidebar').className).toBe('');
    expect(h.el('backdrop').hidden).toBe(false);

    // The only other way out is the collapse button, which the open drawer covers the chat to show.
    await h.click('#backdrop');
    expect(h.el('sidebar').className).toBe('collapsed');
    expect(h.el('backdrop').hidden).toBe(true);
  });

  it('gets out of the way once a topic has been picked', async () => {
    const h = await open({ width: 390, height: 844 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));
    await h.click('#expand-sidebar');

    await h.click('[data-topic="b2c3d4e5"]');

    expect(h.el('sidebar').className).toBe('collapsed');
    expect(h.el('backdrop').hidden).toBe(true);
  });

  it('leaves a wide screen alone', async () => {
    const h = await open({ width: 1440, height: 900 });
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4', 'b2c3d4e5']));

    expect(h.el('sidebar').className).toBe('');
    expect(h.doc.activeElement).toBe(h.el('input'));

    await h.click('[data-topic="b2c3d4e5"]');
    // A column, not a drawer: picking a topic has no reason to collapse it.
    expect(h.el('sidebar').className).toBe('');
  });

  it('keeps the backdrop out of the way of a wide screen', async () => {
    // It is `position:fixed; inset:0`, so if the base rule ever stopped hiding it the whole
    // desktop UI would be behind an invisible sheet that swallows every click.
    const h = await open({ width: 1440, height: 900 });
    expect(h.window.getComputedStyle(h.el('backdrop')).display).toBe('none');
  });
});

describe('webui page: the narrow-screen stylesheet', () => {
  /**
   * The text of the one `@media(max-width:640px)` block, sliced out of the served CSS.
   *
   * Read as text rather than through `document.styleSheets`, for two reasons. jsdom does not
   * evaluate `@media` at all, so the CSSOM could never answer "does this rule apply" anyway —
   * and its CSS parser silently DROPS declarations it cannot parse while normalizing selectors
   * as it likes. Under jsdom 27 that made `#bar`'s `calc(… + env(safe-area-inset-bottom))`
   * vanish and `html,body` come back under a different key, failing assertions about rules that
   * were perfectly correct. Slicing keeps this about the stylesheet the daemon serves rather
   * than about one parser's coverage of modern CSS.
   */
  const narrowBlock = (): string => {
    const html = renderPage('Chat');
    const at = html.indexOf('@media(max-width:640px){');
    if (at < 0) throw new Error('there is no narrow-screen block in the stylesheet');
    let depth = 0;
    for (let i = html.indexOf('{', at); i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
    }
    throw new Error('the narrow-screen block is never closed');
  };

  it('turns the sidebar into a drawer that clears the screen when shut', () => {
    const css = narrowBlock();
    expect(css).toContain('#sidebar{position:fixed');
    // -240px would leave a strip of the wider drawer still on screen.
    expect(css).toContain('#sidebar.collapsed{margin-left:-100%}');
    expect(css).toContain('#backdrop{display:block}');
  });

  it('measures height in dvh, which is the viewport the URL bar has left', () => {
    const css = narrowBlock();
    expect(css).toContain('html,body{height:100vh;height:100dvh}');
    expect(css).toContain('#input{max-height:30dvh}');
  });

  it('keeps fields at 16px so Safari does not zoom in and stay there', () => {
    expect(narrowBlock()).toContain('#input,#secret{font-size:16px}');
  });

  it('pads the send row past the home indicator', () => {
    expect(narrowBlock()).toContain('env(safe-area-inset-bottom');
  });

  it('gives the drawer toggle a finger-sized target', () => {
    const css = narrowBlock();
    // At the inherited .btn-icon size this is a ~21px box, and it is the only way back to the
    // topic list once the drawer is shut.
    expect(css).toMatch(/#expand-sidebar:not\(\[hidden\]\)\{[^}]*min-width:44px/);
    expect(css).toMatch(/#expand-sidebar:not\(\[hidden\]\)\{[^}]*height:44px/);
    // :not([hidden]) is load-bearing: the rule sets `display`, which would otherwise beat the
    // UA's [hidden] rule and leave the toggle on screen while the drawer is open.
    expect(css).not.toMatch(/#expand-sidebar\{/);
  });

  it('scopes all of that to the narrow screen and nothing else', () => {
    // The point of slicing the block rather than searching the document: these rules must be
    // INSIDE it. A drawer and 16px fields applied unconditionally would wreck the desktop
    // layout, and an assertion against the whole stylesheet would not notice.
    const css = narrowBlock();
    expect(css.startsWith('@media(max-width:640px){')).toBe(true);
    expect(css.endsWith('}')).toBe(true);
    expect(css.slice('@media'.length)).not.toContain('@media');
  });
});
