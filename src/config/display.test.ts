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

  it('reactions default to on, so existing deployments keep their 👀/✅ markers', () => {
    expect(parseConfig(raw()).display.reactions.enabled).toBe(true);
  });

  it('reactions can be switched off from config.yaml', () => {
    const cfg = parseConfig(raw({ reactions: { enabled: false } }));
    expect(cfg.display.reactions.enabled).toBe(false);
  });

  it('switching reactions off leaves the frozen emoji themselves in place', () => {
    // The toggle must not be confused with the emoji: those stay in EXPERIENCE, which is why the
    // switch had to go under `display` instead of next to them under `inbound.reactions`.
    const cfg = parseConfig(raw({ reactions: { enabled: false } }));
    expect(cfg.inbound.reactions.received).toBe('👀');
    expect(cfg.inbound.reactions.done).toBe('✅');
  });

  it('a reactions toggle written under `inbound` is discarded (frozen block owns it)', () => {
    // Same trap as `stream` above: `inbound` belongs to EXPERIENCE, so putting the switch there
    // would be silently overwritten. Pins that the working location is `display`.
    const cfg = parseConfig({ ...raw(), inbound: { reactions: { enabled: false } } } as never);
    expect(cfg.display.reactions.enabled).toBe(true);
    expect((cfg.inbound.reactions as Record<string, unknown>).enabled).toBeUndefined();
  });
});

/**
 * `stream.enabled` is the one field of the frozen `stream` block that IS user surface, so it needs
 * the deep merge `session` already has. Everything above documents what happens without it: the
 * `...EXPERIENCE` spread replaces the whole `stream` object, and an operator's value survives until
 * the next restart and then silently reverts — with `/setting` making that far easier to hit,
 * since the write succeeds and the ack says "in effect now".
 */
describe('stream.enabled survives the experience merge', () => {
  const raw = (stream?: unknown): Record<string, unknown> => ({
    platforms: { tg: { type: 'telegram', token: 't' } },
    agents: [{ id: 'cc', harness: 'claude' }],
    routing: { default: 'cc' },
    ...(stream !== undefined ? { stream } : {}),
  });

  it('defaults to off — replies arrive as whole messages unless asked otherwise', () => {
    expect(parseConfig(raw()).stream.enabled).toBe(false);
  });

  it('keeps enabled=true set by the operator', () => {
    expect(parseConfig(raw({ enabled: true })).stream.enabled).toBe(true);
  });

  it('keeps the frozen tuning alongside the operator value, not instead of it', () => {
    const cfg = parseConfig(raw({ enabled: true }));
    expect(cfg.stream.enabled).toBe(true);
    expect(cfg.stream.charThreshold).toBe(200);
    expect(cfg.stream.flushIntervalMs).toBe(1200);
    expect(cfg.stream.silentToken).toBe('[SILENT]');
  });

  it('rejects a non-boolean instead of silently coercing it', () => {
    expect(() => parseConfig(raw({ enabled: 'yes' }))).toThrow();
  });

  it('ignores a throttling knob written into the file — those stay frozen', () => {
    const cfg = parseConfig(raw({ enabled: true, charThreshold: 9999 }) as never);
    expect(cfg.stream.charThreshold).toBe(200);
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
