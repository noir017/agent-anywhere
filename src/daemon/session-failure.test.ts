import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  sessionFailureMeta,
  supportsAirSessionFailures,
} from '@agentclientprotocol/claude-agent-acp/dist/session-failure-extension.js';
import {
  describeSessionFailure,
  failureNoticeKey,
  readSessionFailure,
  SESSION_FAILURE_CAPABILITY_META,
  type SessionFailure,
} from './session-failure.js';

/** A record's `_meta`, shaped the way claude-agent-acp 0.81.x encodes one. */
const meta = (record: Record<string, unknown>): unknown => ({
  jetbrains: { air: { version: 1, sessionFailure: record } },
});

const failure = (over: Partial<SessionFailure> = {}): SessionFailure => ({
  id: 'p1:error',
  severity: 'warning',
  category: 'service',
  title: 'Retrying Claude, attempt 2 of 10.',
  ...over,
});

describe('readSessionFailure', () => {
  it('reads a retry warning and a terminal error', () => {
    expect(
      readSessionFailure(
        meta({ id: 'p1:error', revision: 2, category: 'service', severity: 'warning', title: 'Retrying Claude, attempt 2 of 10.', actions: [] })
      )
    ).toEqual(failure());
    expect(
      readSessionFailure(
        meta({ id: 'p1:error', revision: 3, category: 'service', severity: 'error', title: ' API Error: 503 ', actions: ['retry'] })
      )
    ).toEqual(failure({ severity: 'error', title: 'API Error: 503' }));
  });

  it('finds nothing where there is no record', () => {
    expect(readSessionFailure(undefined)).toBeUndefined();
    expect(readSessionFailure(null)).toBeUndefined();
    // What every ordinary prompt response carries: the adapter's quota report, no failure.
    expect(readSessionFailure({ quota: { token_count: {} } })).toBeUndefined();
    expect(readSessionFailure({ jetbrains: { air: { version: 1 } } })).toBeUndefined();
    expect(readSessionFailure({ jetbrains: { air: { sessionFailure: [] } } })).toBeUndefined();
  });

  it('treats a record with nothing to say as absent', () => {
    expect(readSessionFailure(meta({ id: 'x', severity: 'error', title: '   ' }))).toBeUndefined();
    expect(readSessionFailure(meta({ severity: 'error', title: 'no id' }))).toBeUndefined();
    expect(readSessionFailure(meta({ id: 'x', severity: 'error', title: 42 }))).toBeUndefined();
  });

  it('never lets an unknown severity fail a turn', () => {
    expect(readSessionFailure(meta({ id: 'x', severity: 'fatal', title: 'something new' }))?.severity).toBe(
      'warning'
    );
    expect(readSessionFailure(meta({ id: 'x', title: 'no severity' }))?.severity).toBe('warning');
  });

  it('keeps details only when there are some', () => {
    expect(readSessionFailure(meta({ id: 'x', severity: 'warning', title: 't', details: '  ' }))).not.toHaveProperty(
      'details'
    );
    expect(readSessionFailure(meta({ id: 'x', severity: 'warning', title: 't', details: 'why' }))?.details).toBe('why');
  });
});

describe('describeSessionFailure', () => {
  it('adds details that say something new, on one line', () => {
    expect(describeSessionFailure(failure({ title: 'Model fallback', details: 'opus declined;\nretried with sonnet' }))).toBe(
      'Model fallback opus declined; retried with sonnet'
    );
  });

  it('does not repeat details that only copy the title', () => {
    // A sign-out arrives with its title copied into details.
    const t = 'Sign in to continue using Claude.';
    expect(describeSessionFailure(failure({ title: t, details: t }))).toBe(t);
  });
});

describe('failureNoticeKey', () => {
  it('collapses a retry series into one notice per cause', () => {
    const attempt = (n: number, category: string): SessionFailure =>
      failure({ category, title: `Retrying Claude, attempt ${n} of 10.` });
    expect(failureNoticeKey(attempt(2, 'service'))).toBe(failureNoticeKey(attempt(3, 'service')));
    expect(failureNoticeKey(attempt(1, 'connection'))).not.toBe(failureNoticeKey(attempt(2, 'service')));
  });

  it('keeps errors apart unless they are the same record', () => {
    const a = failure({ severity: 'error', id: 's:session-error:e:1' });
    const b = failure({ severity: 'error', id: 's:session-error:e:2' });
    expect(failureNoticeKey(a)).not.toBe(failureNoticeKey(b));
    expect(failureNoticeKey(a)).toBe(failureNoticeKey({ ...a, title: 'revised' }));
    // ...and an error is never hidden behind a warning about the same thing.
    expect(failureNoticeKey(a)).not.toBe(failureNoticeKey(failure({ id: a.id })));
  });
});

/**
 * Hyrum's Law guards for a private extension (see session-failure.ts). Each one fails loudly in
 * the case where the gateway would otherwise lose the records without noticing, and a retry loop
 * would read as a hang again.
 */
describe('the installed claude-agent-acp (contract)', () => {
  it('accepts the capability the gateway advertises', () => {
    // The whole object runtime sends at initialize, not just the `_meta` part.
    const capabilities = {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      elicitation: { form: {} },
      _meta: SESSION_FAILURE_CAPABILITY_META,
    };
    expect(supportsAirSessionFailures(capabilities)).toBe(true);
    // ...and only because of it: without the key the adapter keeps its legacy contract.
    expect(supportsAirSessionFailures({ ...capabilities, _meta: undefined })).toBe(false);
  });

  it('encodes records the way the gateway reads them', () => {
    const encoded = sessionFailureMeta({
      id: 'p1:error',
      revision: 4,
      category: 'service',
      severity: 'error',
      title: 'API Error: 503',
      details: 'no available channel',
      actions: ['retry'],
    } as Parameters<typeof sessionFailureMeta>[0]);
    expect(readSessionFailure(encoded)).toEqual({
      id: 'p1:error',
      severity: 'error',
      category: 'service',
      title: 'API Error: 503',
      details: 'no available channel',
    });
  });

  it('still sends retries as records, and settles a failed turn as end_turn with one', () => {
    const dist = readFileSync(
      createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'),
      'utf8'
    );
    // The fix for the false "hung": each api_retry becomes a warning record.
    const retry = dist.indexOf('case "api_retry"');
    expect(retry).toBeGreaterThan(0);
    expect(dist.slice(retry, retry + 2500)).toContain('publishSessionFailure(kind, { title, severity: "warning" })');
    // The reason runTurn must read the prompt response: a failed turn RESOLVES once a client asks
    // for records. If this ever goes back to a rejection, the read is harmless; if the shape moves,
    // failed turns would be reported as successes.
    expect(dist).toContain('settleActive(turnOutcome(session, "end_turn", sessionFailureMeta(failure)), "providerError")');
  });
});
