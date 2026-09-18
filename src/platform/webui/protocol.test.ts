import { describe, it, expect } from 'vitest';

import { ClickRequestSchema, LoginRequestSchema, SendRequestSchema, parseBody } from './protocol.js';

/**
 * These schemas are the shape of everything that crosses into the daemon from a browser, so
 * the assertions worth having are the rejections. `.strict()` in particular: an unknown key
 * silently surviving validation is how a field the server never declared ends up being read
 * by something downstream later.
 */
describe('webui protocol: inbound validation', () => {
  it('accepts a plain message', () => {
    expect(parseBody(SendRequestSchema, { text: 'hi' })).toEqual({ ok: true, value: { text: 'hi' } });
  });

  it('accepts a message with attachments', () => {
    const body = { text: '', files: [{ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }] };
    expect(parseBody(SendRequestSchema, body).ok).toBe(true);
  });

  it.each([
    ['an unknown key', { text: 'hi', admin: true }],
    ['a wrong type', { text: 42 }],
    ['a missing field', {}],
    ['a non-object', 'hi'],
    ['null', null],
    ['too many files', { text: '', files: Array.from({ length: 11 }, () => ({ name: 'a', mime: '', data: '' })) }],
    ['an unknown key inside a file', { text: '', files: [{ name: 'a', mime: '', data: '', path: '/etc/passwd' }] }],
    ['a nameless file', { text: '', files: [{ name: '', mime: '', data: '' }] }],
  ])('rejects %s', (_label, body) => {
    expect(parseBody(SendRequestSchema, body).ok).toBe(false);
  });

  it('names the offending path so a 400 is debuggable', () => {
    const res = parseBody(SendRequestSchema, { text: 42 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('text');
  });

  it.each([
    ['both ids present', { messageId: 'm1', buttonId: 'ask:r1:0' }, true],
    ['a missing button', { messageId: 'm1' }, false],
    ['an empty id', { messageId: '', buttonId: 'b' }, false],
    ['an extra key', { messageId: 'm1', buttonId: 'b', as: 'admin' }, false],
  ])('click with %s', (_label, body, want) => {
    expect(parseBody(ClickRequestSchema, body).ok).toBe(want);
  });

  it.each([
    ['a secret', { token: 's3cret' }, true],
    ['an empty secret', { token: '' }, false],
    ['no secret', {}, false],
    ['an extra key', { token: 's', remember: true }, false],
  ])('login with %s', (_label, body, want) => {
    expect(parseBody(LoginRequestSchema, body).ok).toBe(want);
  });
});
