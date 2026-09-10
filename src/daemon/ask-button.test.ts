import { describe, expect, it } from 'vitest';
import { composeElicitPrompt, parseAskButtonId } from './daemon.js';
import type { ElicitQuestion } from '../types.js';

describe('parseAskButtonId', () => {
  it('parses a valid ask:<reqId>:<index>', () => {
    expect(parseAskButtonId('ask:ab12cd34:0')).toEqual({ reqId: 'ab12cd34', index: 0 });
    expect(parseAskButtonId('ask:ab12cd34:3')).toEqual({ reqId: 'ab12cd34', index: 3 });
  });

  it('non-ask prefix returns null (reserved for future slash/other interactions)', () => {
    expect(parseAskButtonId('input:foo:0')).toBeNull();
    expect(parseAskButtonId('other:1')).toBeNull();
    expect(parseAskButtonId('')).toBeNull();
  });

  it('missing index / invalid index returns null', () => {
    expect(parseAskButtonId('ask:ab12')).toBeNull();
    expect(parseAskButtonId('ask:ab12:')).toBeNull();
    expect(parseAskButtonId('ask:ab12:x')).toBeNull();
    expect(parseAskButtonId('ask:ab12:-1')).toBeNull();
    expect(parseAskButtonId('ask::0')).toBeNull();
  });

  it('splits on the last colon when reqId contains non-separator chars', () => {
    // reqId from randomUUID().slice(0,8) contains no colon; this conservatively checks lastIndexOf behavior.
    expect(parseAskButtonId('ask:a:b:2')).toEqual({ reqId: 'a:b', index: 2 });
  });
});

describe('composeElicitPrompt (what the user reads above the buttons)', () => {
  const q = (options: ElicitQuestion['options']): ElicitQuestion => ({
    key: 'question_0',
    prompt: '这个项目用哪个数据库？',
    options,
    multi: false,
  });

  it('carries the option rationales, which the buttons cannot', () => {
    // Shape and wording taken from a real claude elicitation (see agent-acp.test.ts): the model
    // writes a reason per option, and losing it leaves the user choosing between bare nouns.
    const text = composeElicitPrompt(
      q([
        { label: 'PostgreSQL', value: 'PostgreSQL', description: '你已经在跑 pgvector，可直接复用。' },
        { label: 'MySQL', value: 'MySQL', description: '生态广泛，但要新起一个实例。' },
      ]),
      0,
      1
    );
    expect(text).toBe(
      '这个项目用哪个数据库？\n\n**PostgreSQL** — 你已经在跑 pgvector，可直接复用。\n**MySQL** — 生态广泛，但要新起一个实例。'
    );
  });

  it('a single question carries no position marker', () => {
    expect(composeElicitPrompt(q([{ label: 'A', value: 'a' }]), 0, 1)).toBe('这个项目用哪个数据库？');
  });

  it('numbers the rounds of a multi-question form', () => {
    expect(composeElicitPrompt(q([{ label: 'A', value: 'a' }]), 1, 3)).toBe('(2/3) 这个项目用哪个数据库？');
  });

  it('options with no rationale add no empty dashes', () => {
    const text = composeElicitPrompt(
      q([
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b', description: 'only B explains itself' },
      ]),
      0,
      1
    );
    expect(text).toBe('这个项目用哪个数据库？\n\n**B** — only B explains itself');
  });
});
