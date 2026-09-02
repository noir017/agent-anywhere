import { describe, it, expect } from 'vitest';
import { SessionTokenRegistry } from './session-token-registry.js';

describe('SessionTokenRegistry', () => {
  it('issues a stable token per session and reverse-resolves it', () => {
    const reg = new SessionTokenRegistry();
    const t1 = reg.tokenFor('s1');
    expect(reg.tokenFor('s1')).toBe(t1); // stable across calls
    expect(reg.sessionFor(t1)).toBe('s1');
  });

  it('issues distinct tokens for distinct sessions', () => {
    const reg = new SessionTokenRegistry();
    expect(reg.tokenFor('s1')).not.toBe(reg.tokenFor('s2'));
  });

  it('returns undefined for an unknown or wrong-length token', () => {
    const reg = new SessionTokenRegistry();
    reg.tokenFor('s1');
    expect(reg.sessionFor('nope')).toBeUndefined();
    expect(reg.sessionFor('')).toBeUndefined();
  });

  it('release clears both lookup directions', () => {
    const reg = new SessionTokenRegistry();
    const t = reg.tokenFor('s1');
    reg.release('s1');
    expect(reg.sessionFor(t)).toBeUndefined();
    // A fresh token is minted after release (not the old one).
    expect(reg.tokenFor('s1')).not.toBe(t);
  });
});
