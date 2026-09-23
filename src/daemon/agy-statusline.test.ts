import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGY_STATUS_FD,
  AGY_STATUS_FD_ENV,
  ensureAgyStatusLine,
  installStatusLine,
  parseAgyStatusFrame,
} from './agy-statusline.js';

/**
 * The status line is the only channel through which agy reports context usage, so what is tested
 * here is the INSTALLED ARTIFACT, not a copy of its logic: the shim is provisioned into a temp
 * config dir, run as agy runs it (JSON on stdin, the daemon's pipe on fd 3), and what it wrote to
 * that pipe is parsed the way the runtime parses it.
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

/**
 * Run the shim exactly as agy does: `input` on stdin, one status line on stdout. `pipe` opens fd 3
 * the way the runtime's spawn does, and `armed` sets the variable naming it — separately, because
 * "fd 3 is open but nobody asked" is what the operator's own agy looks like.
 */
function runShim(input: string, opts: { pipe?: boolean; armed?: boolean } = {}) {
  const pipe = opts.pipe ?? true;
  const armed = opts.armed ?? pipe;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (armed) env[AGY_STATUS_FD_ENV] = String(AGY_STATUS_FD);
  else delete env[AGY_STATUS_FD_ENV];
  const r = spawnSync(join(process.env.AGENT_ANYWHERE_CONFIG_DIR!, 'bin', 'agy-statusline'), {
    input,
    env,
    encoding: 'utf8',
    stdio: pipe ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  const reported = pipe ? String(r.output[AGY_STATUS_FD] ?? '') : '';
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, reported };
}

/** Every frame the shim reported, parsed the way the runtime parses them. */
function reportedFrames(reported: string) {
  return reported
    .split('\n')
    .filter(Boolean)
    .map((l) => parseAgyStatusFrame(l));
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

  it('removes the per-conversation usage files earlier versions left behind', () => {
    // Nothing reads them any more and nothing else would ever delete them — the machine that
    // prompted the pipe had accumulated 39.
    const { home } = rig({});
    const legacy = join(process.env.AGENT_ANYWHERE_CONFIG_DIR!, 'agy-usage');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'some-conversation.json'), JSON.stringify({ used: 1, size: 2 }));
    installStatusLine(home);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('the installed shim', () => {
  it('reports the window and the model to the daemon over fd 3', () => {
    const { home } = rig({});
    installStatusLine(home);
    const { reported } = runShim(JSON.stringify(FRAME));
    expect(reportedFrames(reported)).toEqual([
      { usage: { used: 22087, size: 1048576 }, model: 'gemini-3.8-flash-high' },
    ]);
  });

  it('names agy’s default model, which on 1.2.9 arrives as a display name in the id slot', () => {
    // Verbatim `model` from agy 1.2.9 (2026-09-23) with no --model= passed: the status line is the
    // only place that default is named at all (`init` carries no model then). The runtime maps the
    // name back to an id; the shim passes on what it was given.
    const { home } = rig({});
    installStatusLine(home);
    const frame = {
      ...FRAME,
      model: { id: 'Claude Sonnet 4.6 (Thinking)', display_name: 'Claude Sonnet 4.6 (Thinking)' },
    };
    expect(reportedFrames(runShim(JSON.stringify(frame)).reported)[0]?.model).toBe('Claude Sonnet 4.6 (Thinking)');
  });

  it('still draws the two lines the operator had — model, context, quota pools', () => {
    const { home } = rig({});
    installStatusLine(home);
    // Taking a setting over is not a licence to change what it shows.
    const out = runShim(JSON.stringify(FRAME)).stdout.split('\n');
    expect(out[0]).toContain('Gemini 3.8 Flash (High)');
    expect(out[0]).toContain('2.1%');
    expect(out[0]).toContain('(22.1k/1.0M)');
    expect(out[1]).toContain('Gemini');
    expect(out[1]).toContain('3P(Claude/GPT)');
    expect(out[1]).toContain('99.7%');
    expect(out[1]).toContain('6d'); // 603831s until the weekly pool resets
  });

  it('reports no numbers from the startup frames, so "0 / 0" never reaches a footer', () => {
    // Verbatim early frame: agy emits several of these before it has authenticated.
    const { home } = rig({});
    installStatusLine(home);
    const boot = {
      conversation_id: 'boot-frame',
      model: null,
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 0, used_percentage: 0 },
      agent_state: 'authenticating',
    };
    expect(runShim(JSON.stringify(boot)).reported).toBe('');
    // The model can be known before the window is: that half is still worth reporting alone.
    const named = { ...boot, model: { id: 'gemini-3.8-flash-high' } };
    expect(reportedFrames(runShim(JSON.stringify(named)).reported)).toEqual([{ model: 'gemini-3.8-flash-high' }]);
  });

  it('writes nothing to fd 3 unless the daemon named it — under the operator’s own agy it only draws', () => {
    // The same shim runs for an agy started by hand, where fd 3 is whatever the shell left open.
    const { home } = rig({});
    installStatusLine(home);
    const r = runShim(JSON.stringify(FRAME), { pipe: true, armed: false });
    expect(r.reported).toBe('');
    expect(r.stdout).toContain('Gemini 3.8 Flash (High)');
  });

  it('draws and exits cleanly when told to report to a descriptor that is not open', () => {
    // What a future agy that closes inherited descriptors looks like from inside the shim: the
    // status line must keep working, and the failure is the runtime's to report, not a stack trace
    // on every render tick.
    const { home } = rig({});
    installStatusLine(home);
    const r = runShim(JSON.stringify(FRAME), { pipe: false, armed: true });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Gemini 3.8 Flash (High)');
  });

  it('prints nothing and fails nothing when handed something that is not a frame', () => {
    // It runs on every render tick; a stack trace per tick would make the TUI unusable.
    const { home } = rig({});
    installStatusLine(home);
    for (const input of [JSON.stringify('not-a-frame-object'), 'definitely not json']) {
      const r = runShim(input);
      expect(r).toMatchObject({ status: 0, stdout: '', stderr: '', reported: '' });
    }
  });
});

describe('parseAgyStatusFrame', () => {
  it('reads both halves, or either one alone', () => {
    expect(parseAgyStatusFrame('{"used":22087,"size":1048576,"model":"gemini-3.8-flash-high"}')).toEqual({
      usage: { used: 22087, size: 1048576 },
      model: 'gemini-3.8-flash-high',
    });
    expect(parseAgyStatusFrame('{"used":0,"size":200000}')).toEqual({ usage: { used: 0, size: 200000 } });
    expect(parseAgyStatusFrame('{"model":"Claude Sonnet 4.6 (Thinking)"}')).toEqual({
      model: 'Claude Sonnet 4.6 (Thinking)',
    });
  });

  it('takes no usage from a window that is not a reading', () => {
    // Zero is agy still authenticating; the others are what a stray writer could put on the pipe.
    for (const bad of ['{"used":5,"size":0}', '{"used":-1,"size":10}', '{"used":"5","size":10}', '{"size":10}']) {
      expect(parseAgyStatusFrame(bad)).toBeUndefined();
    }
  });

  it('treats the pipe as untrusted — anything agy started can write to it', () => {
    for (const bad of ['not json', '[]', 'null', '"a string"', '{}', '{"model":"   "}', '{"model":42}']) {
      expect(parseAgyStatusFrame(bad)).toBeUndefined();
    }
    // A name is printed on every reply, so an absurd one is refused rather than truncated.
    expect(parseAgyStatusFrame(JSON.stringify({ model: 'x'.repeat(500) }))).toBeUndefined();
    expect(parseAgyStatusFrame('{"model":"  gemini-3.8-flash-high  "}')).toEqual({ model: 'gemini-3.8-flash-high' });
  });
});
