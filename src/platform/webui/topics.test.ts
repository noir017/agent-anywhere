import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TopicStore } from './topics.js';

let dir = '';
let file = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-topics-'));
  file = path.join(dir, 'topics.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('TopicStore', () => {
  it('mints ids that carry no character the address form gives meaning to', () => {
    // A topic id travels as the lane half of `main/<id>`, which `parseAddress` splits on `/`
    // and refuses to see twice — so an id containing one would break `--channel` and the
    // listen allowlist, far from here.
    const id = new TopicStore(file).create().id;
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('survives a restart, which is the whole reason it is a file', () => {
    // Losing it does not just empty the page: conversations.json still holds the agent binding
    // and session id under `<instance>#main#<id>`, so every context would still be alive and
    // no longer reachable.
    const first = new TopicStore(file);
    const a = first.create('alpha');
    first.touch(a.id, 12_345);

    const reopened = new TopicStore(file);
    expect(reopened.get(a.id)).toEqual({ id: a.id, title: 'alpha', lastAt: 12_345 });
  });

  it('orders most recently active first', () => {
    const store = new TopicStore(file);
    const a = store.create('a');
    const b = store.create('b');
    store.touch(a.id, 100);
    store.touch(b.id, 200);
    expect(store.list().map((t) => t.title)).toEqual(['b', 'a']);
  });

  it('always has a topic to be in, including on a fresh install', () => {
    const store = new TopicStore(file);
    expect(store.list()).toHaveLength(0);
    const current = store.current();
    expect(store.has(current.id)).toBe(true);
    // And it does not keep minting them once one exists.
    expect(store.current().id).toBe(current.id);
  });

  it('seeds a blank name from the first thing said, and never overwrites a real one', () => {
    const store = new TopicStore(file);
    const t = store.create();
    expect(store.seed(t.id, '  fix the   login timeout  ')).toBe(true);
    expect(store.get(t.id)?.title).toBe('fix the login timeout');
    expect(store.seed(t.id, 'something else')).toBe(false);
    expect(store.get(t.id)?.title).toBe('fix the login timeout');
  });

  it('truncates a long seed rather than putting a paragraph in the switcher', () => {
    const store = new TopicStore(file);
    const t = store.create();
    store.seed(t.id, 'x'.repeat(200));
    expect(store.get(t.id)?.title.length).toBeLessThanOrEqual(33);
    expect(store.get(t.id)?.title.endsWith('…')).toBe(true);
  });

  it('renames, which is what the harness-generated title lands on', () => {
    const store = new TopicStore(file);
    const t = store.create();
    expect(store.rename(t.id, '  [cc] 修复登录超时  ')).toBe(true);
    expect(store.get(t.id)?.title).toBe('[cc] 修复登录超时');
    expect(store.rename(t.id, '   ')).toBe(false);
    expect(store.rename('nope', 'x')).toBe(false);
  });

  it('deletes a topic and persists the removal across restarts', () => {
    const store = new TopicStore(file);
    const a = store.create('first');
    const b = store.create('second');
    expect(store.has(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(true);
    expect(store.has(a.id)).toBe(false);
    expect(store.delete(a.id)).toBe(false);
    expect(store.delete('nonexistent')).toBe(false);

    // Reopened store no longer has the deleted topic
    const reopened = new TopicStore(file);
    expect(reopened.has(a.id)).toBe(false);
    expect(reopened.has(b.id)).toBe(true);
  });

  it('forgets every topic in one write, leaving current() to mint the replacement', () => {
    const store = new TopicStore(file);
    store.create('first');
    store.create('second');

    expect(store.clear()).toBe(2);
    expect(store.list()).toEqual([]);
    // Empty rather than pre-seeded: `current()` is the one place that decides the page is never
    // without a room to be in, and two places deciding it is how they come to disagree.
    expect(new TopicStore(file).list()).toEqual([]);
    expect(store.clear()).toBe(0);

    const fresh = store.current();
    expect(new TopicStore(file).list().map((t) => t.id)).toEqual([fresh.id]);
  });

  it('refuses past its cap instead of evicting, because evicting orphans a live session', () => {
    const store = new TopicStore(file);
    for (let i = 0; i < 64; i += 1) store.create();
    expect(() => store.create()).toThrow(/already has 64 topics/);
  });

  it('starts empty on a corrupt file rather than taking the daemon down', () => {
    fs.writeFileSync(file, 'not json at all');
    expect(new TopicStore(file).list()).toEqual([]);
  });

  it('drops malformed entries rather than trusting them', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        'aaaaaaaa': { title: 'good', lastAt: 5 },
        'not-an-id': { title: 'bad', lastAt: 5 },
        'bbbbbbbb': 'not an object',
        'cccccccc': { title: 42, lastAt: 'soon' },
      })
    );
    const store = new TopicStore(file);
    expect(store.list().map((t) => t.id).sort()).toEqual(['aaaaaaaa', 'cccccccc']);
    // The salvageable one keeps what was readable and defaults the rest.
    expect(store.get('cccccccc')).toEqual({ id: 'cccccccc', title: '', lastAt: 0 });
  });
});
