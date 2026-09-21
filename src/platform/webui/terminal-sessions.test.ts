import { Socket } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { TerminalSessions } from './terminal-sessions.js';

/**
 * The bookkeeping either side of the terminal's bytes.
 *
 * Two things are worth a test here and neither is about ttyd: that a count follows its socket
 * down (a marker that never goes out is the failure mode), and that the operator's command is
 * run as argv rather than through a shell.
 */
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-term-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A socket nothing is connected to — `attach` only ever listens to it. */
const socket = (): Socket => new Socket();

/** `node -e`, so these tests do not depend on a shell or on /bin/false existing. */
function node(script: string, ...args: string[]): string[] {
  return [process.execPath, '-e', script, ...args];
}

describe('TerminalSessions: who is attached', () => {
  it('counts a pane for the life of its socket', () => {
    const sessions = new TerminalSessions();
    const s = socket();
    expect(sessions.has('a1b2c3d4')).toBe(false);

    sessions.attach('a1b2c3d4', s);
    expect(sessions.has('a1b2c3d4')).toBe(true);

    s.emit('close');
    expect(sessions.has('a1b2c3d4')).toBe(false);
  });

  it('lets go on a FIN as well as a close', () => {
    // The lesson `bindTeardown` learned the expensive way: an http.Server socket reports its
    // peer's FIN as `end` and then sits half-open. A count that only listened for `close`
    // would outlive the tab that opened it.
    const sessions = new TerminalSessions();
    const s = socket();
    sessions.attach('a1b2c3d4', s);
    s.emit('end');
    expect(sessions.has('a1b2c3d4')).toBe(false);
  });

  it('does not decrement twice when both events fire', () => {
    // They normally BOTH fire — `end` then `close` — which without the guard would take a
    // second pane's count down with the first one's socket.
    const sessions = new TerminalSessions();
    const first = socket();
    const second = socket();
    sessions.attach('a1b2c3d4', first);
    sessions.attach('a1b2c3d4', second);

    first.emit('end');
    first.emit('close');
    expect(sessions.has('a1b2c3d4')).toBe(true);

    second.emit('close');
    expect(sessions.has('a1b2c3d4')).toBe(false);
  });

  it('notifies only when a topic gains its first pane or loses its last', () => {
    // Because every notification is a topic list re-announced to every client. A second tab on
    // a topic that already has one changes nothing anybody can see.
    const sessions = new TerminalSessions();
    let changes = 0;
    sessions.onChange(() => {
      changes += 1;
    });

    const first = socket();
    const second = socket();
    sessions.attach('a1b2c3d4', first);
    expect(changes).toBe(1);
    sessions.attach('a1b2c3d4', second);
    expect(changes).toBe(1);

    first.emit('close');
    expect(changes).toBe(1);
    second.emit('close');
    expect(changes).toBe(2);
  });

  it('keeps topics apart', () => {
    const sessions = new TerminalSessions();
    const s = socket();
    sessions.attach('a1b2c3d4', s);
    expect(sessions.has('b2c3d4e5')).toBe(false);
  });
});

describe('TerminalSessions: ending one', () => {
  it('has nothing to offer without a configured command', async () => {
    const sessions = new TerminalSessions();
    expect(sessions.canEnd).toBe(false);
    const result = await sessions.end('a1b2c3d4');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('endCommand') });
  });

  it('substitutes the topic into every argument and runs the command', async () => {
    const stamp = path.join(dir, 'ended.txt');
    const sessions = new TerminalSessions(
      node('require("fs").writeFileSync(process.argv[1], process.argv[2])', stamp, 'aa-{topic}')
    );
    expect(sessions.canEnd).toBe(true);

    expect(await sessions.end('a1b2c3d4')).toEqual({ ok: true });
    expect(fs.readFileSync(stamp, 'utf8')).toBe('aa-a1b2c3d4');
  });

  it('passes the topic as an argument, never as syntax', async () => {
    // The reason this is execFile and not exec. The id is `^[0-9a-f]{8}$` by the time it gets
    // here, so this asks the question the pattern is the second answer to: with no shell, a
    // substituted string cannot become a second command however it is spelled.
    const stamp = path.join(dir, 'arg.txt');
    const sessions = new TerminalSessions(
      node('require("fs").writeFileSync(process.argv[1], process.argv[2])', stamp, '{topic}')
    );
    const nasty = `; touch ${path.join(dir, 'pwned')}`;

    expect(await sessions.end(nasty)).toEqual({ ok: true });
    expect(fs.readFileSync(stamp, 'utf8')).toBe(nasty);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('reports a command that failed rather than claiming the session is gone', async () => {
    const sessions = new TerminalSessions(node('process.exit(3)', '{topic}'));
    const result = await sessions.end('a1b2c3d4');
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('could not end'));
  });

  it('reports a command that is not there', async () => {
    const sessions = new TerminalSessions([path.join(dir, 'no-such-program'), '{topic}']);
    const result = await sessions.end('a1b2c3d4');
    expect(result.ok).toBe(false);
  });

  it('leaves the count alone — the closing socket is what clears it', async () => {
    // Two ways of reaching zero would eventually disagree. Ending the session makes ttyd drop
    // the connection, and that arrives as a socket close like any other.
    const sessions = new TerminalSessions(node('process.exit(0)', '{topic}'));
    const s = socket();
    sessions.attach('a1b2c3d4', s);

    expect(await sessions.end('a1b2c3d4')).toEqual({ ok: true });
    expect(sessions.has('a1b2c3d4')).toBe(true);

    s.emit('close');
    expect(sessions.has('a1b2c3d4')).toBe(false);
  });
});
