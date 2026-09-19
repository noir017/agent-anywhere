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
 * fire every click handler twice.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM, type DOMWindow } from 'jsdom';

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
  el: (id: string) => HTMLElement;
  /** Messages currently painted in the transcript. */
  painted: () => number;
  /** Topic rows currently painted in the sidebar. */
  rows: () => number;
  click: (selector: string) => Promise<void>;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Spin the macrotask queue until something becomes true.
 *
 * `FileReader` resolves over several turns in jsdom, and how many is an implementation detail —
 * a fixed number of `tick()`s here would be a test that passes until jsdom changes its mind.
 */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (ok()) return;
    await tick();
  }
  throw new Error(`never happened: ${what}`);
}

/** A sync in the shape `WebRoom.syncEvent` builds it. */
function sync(topic: string, messages: Array<Record<string, unknown>>, topics: string[]): Record<string, unknown> {
  return {
    t: 'sync',
    topic,
    messages,
    commands: [{ name: 'new', description: 'start over' }],
    topics: topics.map((id, i) => ({
      id,
      title: `Topic ${id}`,
      lastAt: 1000 - i,
      running: false,
      msgCount: id === topic ? messages.length : 0,
    })),
  };
}

function message(id: string, html: string, own = false): Record<string, unknown> {
  return { id, html, at: 1758240000000, own };
}

async function open(opts: { url?: string; width?: number; height?: number } = {}): Promise<Harness> {
  const { url = 'http://localhost:8787/', width = 1440, height = 900 } = opts;
  const streams: Stream[] = [];
  const calls: Call[] = [];

  const dom = new JSDOM(renderPage('Chat'), {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
      Object.defineProperty(w, 'innerHeight', { value: height, configurable: true });
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
      (w as any).confirm = () => true;
      (w as any).fetch = (path: string, init: { body: string }) => {
        calls.push({ path, body: JSON.parse(init.body) });
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
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
    emit: async (ev) => {
      live().onmessage?.({ data: JSON.stringify(ev) });
      await tick();
    },
    el: (id) => {
      const found = doc.getElementById(id);
      if (!found) throw new Error(`#${id} is not in the document`);
      return found;
    },
    painted: () => doc.getElementById('log')!.children.length,
    rows: () => doc.getElementById('topics')!.children.length,
    click: async (selector) => {
      const target = doc.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`nothing matches ${selector}`);
      target.click();
      await tick();
    },
  };
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
    // Nothing cached for B yet, and its stream has said nothing: an honest blank.
    expect(h.painted()).toBe(0);
    expect(h.live().url).toBe('api/events?t=b2c3d4e5');

    await h.click('[data-topic="a1b2c3d4"]');
    // A came back with no sync emitted at all — this is the cache, and the point of it.
    expect(h.painted()).toBe(2);
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

  it('refuses to send nothing', async () => {
    const h = await open();
    await h.emit(sync('a1b2c3d4', [], ['a1b2c3d4']));
    (h.el('input') as HTMLTextAreaElement).value = '   ';

    await h.click('#composer button[type="submit"]');

    expect(h.calls.filter((c) => c.path === 'api/send')).toHaveLength(0);
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
