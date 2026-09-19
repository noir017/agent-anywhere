import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgyStatusLine, installStatusLine, readAgyUsage, agyUsageDir } from './agy-statusline.js';

/**
 * The status line is the only channel through which agy reports context usage, so what is tested
 * here is the INSTALLED ARTIFACT, not a copy of its logic: the shim is provisioned into a temp
 * config dir, run as agy runs it (JSON on stdin), and then read back the way the runtime reads it.
 *
 * The frame below is verbatim from `agy 1.2.0` (2026-09-17), captured by pointing settings.json at
 * a recording script and running one two-turn stream-json session. It is the last frame of that
 * session, which is why the numbers are non-zero — the early frames report `agent_state:
 * "authenticating"` and a window of 0, and the "is this zero real" case has its own test.
 */

const FRAME = {
  cwd: '/tmp',
  session_id: '27fc647a-856a-4064-8b15-bc4c394ec733',
  conversation_id: '27fc647a-856a-4064-8b15-bc4c394ec733',
  model: { id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)', effort: 'high' },
  version: '1.2.0',
  context_window: {
    total_input_tokens: 22087,
    total_output_tokens: 2289,
    context_window_size: 1048576,
    used_percentage: 2.1063804626464844,
    remaining_percentage: 97.89361953735352,
    current_usage: { input_tokens: 16434, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
  quota: {
    '3p-5h': { remaining_fraction: 1, reset_in_seconds: 17998 },
    '3p-weekly': { remaining_fraction: 0.9389305, reset_in_seconds: 414442 },
    'gemini-5h': { remaining_fraction: 0.9835127, reset_in_seconds: 17031 },
    'gemini-weekly': { remaining_fraction: 0.9972521, reset_in_seconds: 603831 },
  },
  agent_state: 'ready',
  terminal_width: 80,
};

const saved = process.env.AGENT_ANYWHERE_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_ANYWHERE_CONFIG_DIR;
  else process.env.AGENT_ANYWHERE_CONFIG_DIR = saved;
  delete process.env.AGENT_ANYWHERE_NO_AGY_STATUSLINE;
});

/** A temp config dir for the daemon plus a temp home carrying an existing agy settings file. */
function rig(settings?: Record<string, unknown>): { home: string; settingsFile: string } {
  process.env.AGENT_ANYWHERE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'aa-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'aa-home-'));
  const dir = join(home, '.gemini', 'antigravity-cli');
  mkdirSync(dir, { recursive: true });
  const settingsFile = join(dir, 'settings.json');
  if (settings) writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return { home, settingsFile };
}

/** Run the shim exactly as agy does: the frame on stdin, one status line on stdout. */
function runShim(frame: unknown): string {
  return execFileSync(join(process.env.AGENT_ANYWHERE_CONFIG_DIR!, 'bin', 'agy-statusline'), {
    input: JSON.stringify(frame),
    encoding: 'utf8',
  });
}

describe('ensureAgyStatusLine', () => {
  it('points agy at the shim while keeping every other setting', () => {
    // The file belongs to another product and carries things that matter (which workspaces are
    // trusted decides whether agy will write to the project at all).
    const { home, settingsFile } = rig({
      model: 'Gemini 3.8 Flash (High)',
      trustedWorkspaces: ['/home/user'],
      statusLine: { type: 'command', command: '/home/user/.gemini/antigravity-cli/statusline.sh', enabled: true },
    });
    expect(installStatusLine(home)).toBe('installed');

    const after = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    expect(after.model).toBe('Gemini 3.8 Flash (High)');
    expect(after.trustedWorkspaces).toEqual(['/home/user']);
    expect(after.statusLine).toMatchObject({ type: 'command', enabled: true });
    expect(String((after.statusLine as { command: string }).command)).toContain('agy-statusline');
  });

  it('keeps the operator’s original settings in a backup, and does not overwrite it later', () => {
    const { home, settingsFile } = rig({ statusLine: { type: 'command', command: '/theirs.sh', enabled: true } });
    installStatusLine(home);
    const backup = `${settingsFile}.bak-agent-anywhere`;
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toMatchObject({ statusLine: { command: '/theirs.sh' } });

    // A second install must not replace the backup with our own output — the first version seen is
    // the only one worth keeping.
    writeFileSync(settingsFile, JSON.stringify({ statusLine: { command: '/something-else.sh' } }));
    installStatusLine(home);
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toMatchObject({ statusLine: { command: '/theirs.sh' } });
  });

  it('is idempotent across restarts', () => {
    const { home } = rig({});
    expect(installStatusLine(home)).toBe('installed');
    expect(installStatusLine(home)).toBe('unchanged');
  });

  it('leaves a machine where agy has never run completely alone', () => {
    // No agy config directory: creating one would be inventing configuration for a product the
    // operator may not use on this machine.
    process.env.AGENT_ANYWHERE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'aa-cfg-'));
    const home = mkdtempSync(join(tmpdir(), 'aa-home-'));
    expect(installStatusLine(home)).toBe('skipped');
    expect(existsSync(join(home, '.gemini'))).toBe(false);
  });

  it('honours the opt-out', () => {
    const { home, settingsFile } = rig({ statusLine: { type: 'command', command: '/theirs.sh', enabled: true } });
    process.env.AGENT_ANYWHERE_NO_AGY_STATUSLINE = '1';
    expect(ensureAgyStatusLine(home)).toBe('skipped');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toMatchObject({ statusLine: { command: '/theirs.sh' } });
  });

  it('refuses to write when this process is not the CLI — a test run is not a daemon start', () => {
    // THE case this guard exists for: settings.json is a shared user path belonging to another
    // product, and before the guard a vitest worker constructing an agy factory rewrote the
    // operator's own. Same lesson, same shape as ensureReverseCliShim's isCliEntry check.
    const { home, settingsFile } = rig({ statusLine: { type: 'command', command: '/theirs.sh', enabled: true } });
    expect(ensureAgyStatusLine(home)).toBe('skipped');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toMatchObject({ statusLine: { command: '/theirs.sh' } });
  });
});

describe('the installed shim', () => {
  it('records the window so the footer can read it back', () => {
    const { home } = rig({});
    installStatusLine(home);
    runShim(FRAME);
    expect(readAgyUsage(FRAME.conversation_id)).toEqual({ used: 22087, size: 1048576 });
  });

  it('still draws the two lines the operator had — model, context, quota pools', () => {
    const { home } = rig({});
    installStatusLine(home);
    // Taking a setting over is not a licence to change what it shows.
    const out = runShim(FRAME).split('\n');
    expect(out[0]).toContain('Gemini 3.8 Flash (High)');
    expect(out[0]).toContain('2.1%');
    expect(out[0]).toContain('(22.1k/1.0M)');
    expect(out[1]).toContain('Gemini');
    expect(out[1]).toContain('3P(Claude/GPT)');
    expect(out[1]).toContain('99.7%');
    expect(out[1]).toContain('6d'); // 603831s until the weekly pool resets
  });

  it('records nothing from the startup frames, so "0 / 0" never reaches a footer', () => {
    // Verbatim early frame: agy emits several of these before it has authenticated.
    const { home } = rig({});
    installStatusLine(home);
    runShim({
      conversation_id: 'boot-frame',
      model: null,
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 0, used_percentage: 0 },
      agent_state: 'authenticating',
    });
    expect(readAgyUsage('boot-frame')).toBeUndefined();
  });

  it('prints nothing and fails nothing when handed something that is not a frame', () => {
    // It runs on every render tick; a stack trace per tick would make the TUI unusable.
    const { home } = rig({});
    installStatusLine(home);
    expect(runShim('not-a-frame-object')).toBe('');
    expect(
      execFileSync(join(process.env.AGENT_ANYWHERE_CONFIG_DIR!, 'bin', 'agy-statusline'), {
        input: 'definitely not json',
        encoding: 'utf8',
      })
    ).toBe('');
  });
});

describe('readAgyUsage', () => {
  it('has no answer before any turn, which is not the same as zero', () => {
    process.env.AGENT_ANYWHERE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'aa-cfg-'));
    expect(readAgyUsage('never-seen')).toBeUndefined();
    expect(readAgyUsage(undefined)).toBeUndefined();
  });

  it('refuses a conversation id that would climb out of the usage directory', () => {
    process.env.AGENT_ANYWHERE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'aa-cfg-'));
    mkdirSync(agyUsageDir(), { recursive: true });
    writeFileSync(join(agyUsageDir(), '.._.._etc_passwd.json'), JSON.stringify({ used: 1, size: 2 }));
    // The traversal attempt lands on the sanitized name, not on anything above the directory.
    expect(readAgyUsage('../../etc/passwd')).toEqual({ used: 1, size: 2 });
  });
});
