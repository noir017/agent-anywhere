import { describe, expect, it } from 'vitest';
import { agentDisplayName, parseConfig } from './schema.js';
import type { AgentDef } from './schema.js';

/**
 * Reply-decoration toggles must survive parseConfig.
 *
 * These go through the REAL parseConfig rather than a hand-built Config object, because that is
 * exactly where the bug lived: the toggles were first written under `stream`, which belongs to the
 * frozen ExperienceSchema. `withExperienceDefaults` spreads `...EXPERIENCE` over the user config, so
 * anything nested there is silently overwritten by the frozen value on every load — the daemon read
 * `enabled: false` no matter what config.yaml said, and the failure was invisible because nothing
 * errored. Unit tests that construct a Config directly cannot see it; only parsing can.
 *
 * The same trap explains why the pre-existing `footer` option never worked: it shipped inside the
 * frozen block, so it could not be enabled from config.yaml at all.
 */
describe('display config survives the experience merge', () => {
  /** Minimal valid user config; `display` is the part under test. */
  const raw = (display?: unknown): Record<string, unknown> => ({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    ...(display !== undefined ? { display } : {}),
  });

  it('keeps header.enabled=true set by the operator', () => {
    const cfg = parseConfig(raw({ header: { enabled: true } }));
    expect(cfg.display.header.enabled).toBe(true);
  });

  it('keeps footer.enabled=true and the chosen fields', () => {
    const cfg = parseConfig(raw({ footer: { enabled: true, fields: ['agent', 'context', 'model'] } }));
    expect(cfg.display.footer.enabled).toBe(true);
    expect(cfg.display.footer.fields).toEqual(['agent', 'context', 'model']);
  });

  it('keeps both toggles on at once (the deployed shape)', () => {
    const cfg = parseConfig(
      raw({ header: { enabled: true }, footer: { enabled: true, fields: ['agent', 'context', 'model'] } }),
    );
    expect(cfg.display.header.enabled).toBe(true);
    expect(cfg.display.footer.enabled).toBe(true);
  });

  it('defaults both to off when the block is absent, so behavior is unchanged by default', () => {
    const cfg = parseConfig(raw());
    expect(cfg.display.header.enabled).toBe(false);
    expect(cfg.display.footer.enabled).toBe(false);
    // Fields still have a usable default, so enabling the footer alone is sufficient.
    expect(cfg.display.footer.fields).toEqual(['agent', 'context', 'model']);
  });

  it('an explicitly disabled toggle stays disabled', () => {
    const cfg = parseConfig(raw({ header: { enabled: false }, footer: { enabled: true } }));
    expect(cfg.display.header.enabled).toBe(false);
    expect(cfg.display.footer.enabled).toBe(true);
  });

  it('rejects a non-boolean enabled instead of silently coercing it', () => {
    // The original bug was silent. A YAML typo must fail loudly, not turn the feature off.
    expect(() => parseConfig(raw({ header: { enabled: 'true' } }))).toThrow();
  });

  it('rejects an unknown footer field', () => {
    expect(() => parseConfig(raw({ footer: { fields: ['agent', 'nonsense'] } }))).toThrow();
  });

  it('does not live under `stream`: the frozen experience block owns that and would overwrite it', () => {
    // Guards the regression directly — if someone moves these back under `stream`, the value set
    // here would be discarded and this assertion fails.
    const cfg = parseConfig({ ...raw(), stream: { header: { enabled: true } } } as never);
    expect((cfg.stream as Record<string, unknown>).header).toBeUndefined();
    expect(cfg.display.header.enabled).toBe(false);
  });

  it('the frozen stream tuning is still merged in and untouched', () => {
    const cfg = parseConfig(raw({ header: { enabled: true } }));
    expect(cfg.stream.charThreshold).toBeGreaterThan(0);
    expect(cfg.stream.silentToken).toBe('[SILENT]');
  });
});

/**
 * Agent display name.
 *
 * The config id is operator shorthand — `oc`, `cc`, whatever is fast to type after a slash — and
 * tells a reader of the conversation nothing. The harness name is what actually answered, spelled
 * the way its own project spells it.
 */
describe('agentDisplayName', () => {
  const def = (o: Record<string, unknown>): AgentDef => o as AgentDef;

  it('uses the harness name, not the config id', () => {
    expect(agentDisplayName(def({ id: 'oc', harness: 'opencode' }), 'oc')).toBe('opencode');
    expect(agentDisplayName(def({ id: 'cc', harness: 'claude' }), 'cc')).toBe('claude');
    expect(agentDisplayName(def({ id: 'x', harness: 'codex' }), 'x')).toBe('codex');
    expect(agentDisplayName(def({ id: 'g', harness: 'gemini' }), 'g')).toBe('gemini');
  });

  it('falls back to the id for a custom harness, where the harness name says nothing', () => {
    expect(agentDisplayName(def({ id: 'my-bot', harness: 'custom', command: '/x' }), 'my-bot')).toBe('my-bot');
  });

  it('falls back to the id when the agent is not in config at all', () => {
    expect(agentDisplayName(undefined, 'ghost')).toBe('ghost');
  });
});
