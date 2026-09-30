import { describe, expect, it } from 'vitest';
import { buildChannelList, laneFromLegacyKey, type ChannelSource } from './channel-list.js';
import { parseTarget } from './conversation.js';

/**
 * The channel list is what an agent reads to name a place to post to, so the property that matters
 * most is that every id it prints parses back through `--channel` to the same place. The rest is
 * ordering and the legacy-key fallback, which exists for records written before `lane` did.
 */

const instances = new Map([
  ['tg', 'telegram'],
  ['web', 'webui'],
]);

const src = (over: Partial<ChannelSource> & { key: string }): ChannelSource => ({ agent: 'cc', ...over });

describe('buildChannelList', () => {
  it('prints ids that --channel parses back to the same place', () => {
    const { rows } = buildChannelList(
      [src({ key: 'tg#586#8068', lane: { platform: 'tg', channel: '586', thread: '8068' }, lastAt: 1 })],
      { instances, limit: 10 }
    );
    const topic = rows.find((r) => r.kind === 'topic')!;
    expect(topic.id).toBe('tg:586/8068');
    expect(parseTarget(topic.id, new Set(instances.keys()))).toEqual({
      platform: 'tg',
      address: { channel: '586', thread: '8068' },
    });
    // The root it lives in is listed too: it is where a new topic would be opened.
    expect(rows[0]).toMatchObject({ id: 'tg:586', kind: 'channel', platform: 'telegram' });
  });

  it('orders topics newest first, falling back to insertion order for undated records', () => {
    const { rows } = buildChannelList(
      [
        src({ key: 'tg#586#1' }),
        src({ key: 'tg#586#2' }),
        src({ key: 'tg#586#3', lane: { platform: 'tg', channel: '586', thread: '3' }, lastAt: 5 }),
      ],
      { instances, limit: 10 }
    );
    expect(rows.filter((r) => r.kind === 'topic').map((r) => r.id)).toEqual(['tg:586/3', 'tg:586/2', 'tg:586/1']);
  });

  it('limits topics but always shows every channel, and reports how many matched', () => {
    const sources = Array.from({ length: 5 }, (_, i) => src({ key: `tg#586#${i}` }));
    sources.push(src({ key: 'web#main#abc' }));
    const list = buildChannelList(sources, { instances, limit: 2 });
    expect(list.rows.filter((r) => r.kind === 'channel').map((r) => r.id).sort()).toEqual(['tg:586', 'web:main']);
    expect(list.rows.filter((r) => r.kind === 'topic')).toHaveLength(2);
    expect(list.totalTopics).toBe(6);
  });

  it('filters by instance and by a case-insensitive query over id, title and agent', () => {
    const sources = [
      src({ key: 'tg#586#1', title: '[cc] 量化策略' }),
      src({ key: 'web#main#abc', title: '[oc] Holiday plan', agent: 'oc' }),
    ];
    expect(buildChannelList(sources, { instances, platform: 'web', limit: 10 }).rows.map((r) => r.id)).toEqual([
      'web:main',
      'web:main/abc',
    ]);
    expect(buildChannelList(sources, { instances, query: 'holiday', limit: 10 }).rows.map((r) => r.id)).toEqual([
      'web:main/abc',
    ]);
    expect(buildChannelList(sources, { instances, query: '量化', limit: 10 }).rows.map((r) => r.id)).toEqual([
      'tg:586/1',
    ]);
  });

  it('marks the asking conversation', () => {
    const { rows } = buildChannelList([src({ key: 'tg#586#1' }), src({ key: 'tg#586#2' })], {
      instances,
      limit: 10,
      currentKey: 'tg#586#1',
    });
    expect(rows.find((r) => r.current)?.id).toBe('tg:586/1');
  });

  it('a channel root that is itself a conversation carries its title and agent', () => {
    const { rows } = buildChannelList([src({ key: 'tg#586#', title: 'DM', agent: 'oc' })], { instances, limit: 10 });
    expect(rows).toEqual([expect.objectContaining({ id: 'tg:586', kind: 'channel', title: 'DM', agent: 'oc' })]);
  });

  it('drops records on instances that are no longer configured', () => {
    const { rows } = buildChannelList(
      [src({ key: 'old#1#2', lane: { platform: 'old', channel: '1', thread: '2' } })],
      { instances, limit: 10 }
    );
    expect(rows).toEqual([]);
  });
});

describe('laneFromLegacyKey', () => {
  it('reads the two scope shapes that name a place', () => {
    expect(laneFromLegacyKey('tg#586#8068', instances)).toEqual({ platform: 'tg', channel: '586', thread: '8068' });
    expect(laneFromLegacyKey('tg#586#', instances)).toEqual({ platform: 'tg', channel: '586' });
    expect(laneFromLegacyKey('tg#586', instances)).toEqual({ platform: 'tg', channel: '586' });
  });

  it('skips what it cannot read unambiguously rather than guessing', () => {
    expect(laneFromLegacyKey('shared', instances)).toBeUndefined();
    expect(laneFromLegacyKey('tg#u#12345', instances)).toBeUndefined(); // per_user names a person
    expect(laneFromLegacyKey('tg#a#b#c', instances)).toBeUndefined(); // a `#` inside an id
    expect(laneFromLegacyKey('nope#1#2', instances)).toBeUndefined(); // not a configured instance
  });
});
