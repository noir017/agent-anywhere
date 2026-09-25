import { describe, it, expect } from 'vitest';
import { parseIpcRequest } from './protocol.js';

/**
 * parseIpcRequest is the runtime trust boundary for the reverse-command IPC: the peer is an
 * arbitrary short-lived process and its JSON is untrusted. Compile-time _AssertActionAligned only
 * guards TS/zod drift; this guards malformed/hostile input at runtime. Tested per action arm plus
 * the rejection paths.
 */
const TOKEN = 'sess_abc';

describe('parseIpcRequest — valid requests round-trip', () => {
  const valid: Record<string, unknown>[] = [
    { kind: 'send-message', text: 'hi' },
    { kind: 'send-message', text: 'hi', channelId: 'c1' },
    { kind: 'reply', messageId: 'm1', text: 'yo' },
    { kind: 'edit-message', messageId: 'm1', text: 'updated' },
    { kind: 'send-file', path: '/tmp/x' },
    { kind: 'send-file', path: '/tmp/x', name: 'x', caption: 'c', channelId: 'c1' },
    { kind: 'react', messageId: 'm1', emoji: '👍' },
    { kind: 'delete', messageId: 'm1' },
    { kind: 'fetch-messages' },
    { kind: 'fetch-messages', limit: 10, before: 'm0' },
    { kind: 'fetch-messages', fields: ['content', 'attachments'] },
    { kind: 'create-thread', messageId: 'm1', name: 'topic' },
    { kind: 'ask', prompt: 'pick', options: ['a', 'b'] },
    { kind: 'ask', prompt: 'pick', options: [], timeoutMs: 5000 },
    { kind: 'voice-log' },
    { kind: 'voice-log', limit: 5 },
  ];
  it.each(valid)('accepts %j', (action) => {
    const r = parseIpcRequest({ token: TOKEN, action });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.action.kind).toBe(action.kind);
  });
});

describe('parseIpcRequest — rejects malformed / hostile input', () => {
  const bad: [string, unknown][] = [
    ['missing token', { action: { kind: 'fetch-messages' } }],
    ['empty token', { token: '', action: { kind: 'fetch-messages' } }],
    ['non-string token', { token: 123, action: { kind: 'fetch-messages' } }],
    ['unknown discriminator', { token: TOKEN, action: { kind: 'rm-rf' } }],
    ['missing required field (reply.text)', { token: TOKEN, action: { kind: 'reply', messageId: 'm1' } }],
    ['wrong field type (text number)', { token: TOKEN, action: { kind: 'send-message', text: 5 } }],
    ['empty channelId string', { token: TOKEN, action: { kind: 'fetch-messages', channelId: '' } }],
    ['extra field (strict)', { token: TOKEN, action: { kind: 'fetch-messages', evil: 1 } }],
    ['extra top-level field', { token: TOKEN, action: { kind: 'fetch-messages' }, evil: 1 }],
    ['non-object', 'just a string'],
    ['null', null],
    ['missing action', { token: TOKEN }],
    ['fetch-messages negative limit', { token: TOKEN, action: { kind: 'fetch-messages', limit: -1 } }],
    // voice-log reads the caller's own conversation only: there is no channel to point it at.
    ['voice-log with a channel', { token: TOKEN, action: { kind: 'voice-log', channelId: 'c2' } }],
    ['voice-log zero limit', { token: TOKEN, action: { kind: 'voice-log', limit: 0 } }],
  ];
  it.each(bad)('rejects %s', (_label, raw) => {
    const r = parseIpcRequest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(typeof r.error).toBe('string');
  });
});
