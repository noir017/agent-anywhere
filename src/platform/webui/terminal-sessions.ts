/**
 * The terminal's *sessions*: who is connected to one, and how one is ended.
 *
 * `terminal-proxy.ts` is the bytes; this is the bookkeeping either side of them. They are
 * separate files because they answer to different things — the proxy answers to ttyd's wire
 * behaviour, this one to what the page shows and what the operator configured.
 *
 * ── What "running" means here, and what it does not ──────────────────────────
 * The topic list's terminal marker is fed by `has()`, which counts **live connections**, not
 * live shells. That is the only thing this process can know without being told what the far
 * side is: the daemon proxies a WebSocket per open pane and watches it die, and that is the
 * whole of its knowledge. A `tmux` session left running with every tab closed is invisible
 * here, and correctly so — nothing in this process has ever heard of tmux.
 *
 * The practical consequence, worth knowing before reading a marker as "something is running":
 * closing the last tab clears every marker, even while work continues on the far side. What
 * the marker honestly says is "a page is attached to this topic's terminal".
 *
 * ── Why ending a session is a configured command ─────────────────────────────
 * Because a session outliving its connection is the operator's arrangement, not ours. ttyd
 * SIGHUPs its child on disconnect; the child survives only because their wrapper is
 * `tmux new -A`, and only they can say how that is reversed. Hard-coding `tmux kill-session`
 * here would trade "works with any backend" for "works with the one we guessed", which is the
 * same trade `terminal-proxy.ts` exists to refuse.
 *
 * So: no command configured, no way to end a session, and the page is told so rather than
 * offered a button that does nothing (`renderPage`'s third flag).
 */
import { execFile } from 'node:child_process';
import type { Socket } from 'node:net';

/** How long the operator's command may take before it is killed and reported as failed. */
const END_TIMEOUT_MS = 10_000;

export class TerminalSessions {
  /** Topic id → how many panes are currently attached to it. Entries are deleted at zero. */
  private readonly live = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly endCommand?: readonly string[]) {}

  /** Whether this deployment can end a session at all — i.e. whether the close button exists. */
  get canEnd(): boolean {
    return Boolean(this.endCommand?.length);
  }

  /**
   * Count one pane against a topic for as long as its socket lives.
   *
   * Takes the socket rather than returning a `detach()` the caller has to remember: the count
   * is what the page paints, and a leaked increment is a marker that never goes out — the kind
   * of bug that is only ever found by someone wondering why a topic claims a terminal it does
   * not have.
   *
   * Both `close` and `end` are listened for, guarded to fire once. `close` alone would be
   * enough *given* that `proxyUpgrade` destroys the pair on `end` — but that is the exact
   * assumption whose failure cost a leaked socket pair per closed tab once already (see
   * `bindTeardown`), and this file should not be the second place it has to hold.
   */
  attach(topic: string, socket: Socket): void {
    this.bump(topic, 1);
    let gone = false;
    const drop = (): void => {
      if (gone) return;
      gone = true;
      this.bump(topic, -1);
    };
    socket.on('close', drop);
    socket.on('end', drop);
  }

  /** Whether any pane is attached to this topic right now. */
  has(topic: string): boolean {
    return this.live.has(topic);
  }

  /** Called when a topic gains its first pane or loses its last — i.e. when a marker flips. */
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  /**
   * Run the operator's command for one topic.
   *
   * Nothing here updates `live`: ending the session makes ttyd drop the connection, which
   * arrives as a socket close and clears the count through the same path every other
   * disconnect takes. Two ways of reaching zero would eventually disagree about it.
   */
  async end(topic: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const argv = this.endCommand;
    if (!argv?.length) return { ok: false, error: 'this daemon has no terminal.endCommand configured' };
    const [file, ...rest] = argv.map((part) => part.replaceAll('{topic}', topic));
    if (!file) return { ok: false, error: 'this daemon has no terminal.endCommand configured' };
    return new Promise((resolve) => {
      // `execFile`, not `exec`: no shell is spawned, so the substituted id is an argument and
      // can never be read as syntax. It is already `^[0-9a-f]{8}$` and known to the topic
      // store by the time it gets here; the missing shell is what makes that belt-and-braces
      // rather than the only thing standing between a URL and a command line.
      execFile(file, rest, { timeout: END_TIMEOUT_MS, windowsHide: true }, (err) => {
        if (!err) return resolve({ ok: true });
        // Logged as well as returned. The page shows the operator's own misconfiguration to
        // whoever clicked the button, and they are usually the same person — but a spawn error
        // (ENOENT on the command itself) is worth having in the daemon log too, because that
        // one is not about the session at all.
        console.warn(`[webui] terminal endCommand failed for ${topic}: ${err.message}`);
        return resolve({ ok: false, error: `could not end the terminal session: ${err.message}` });
      });
    });
  }

  private bump(topic: string, by: number): void {
    const before = this.live.get(topic) ?? 0;
    const after = before + by;
    if (after > 0) this.live.set(topic, after);
    else this.live.delete(topic);
    // Only when the marker actually flips. A second pane on a topic that already has one
    // changes nothing anybody can see, and re-announcing the whole topic list to every client
    // for it would be a broadcast per tab.
    if (before === 0 || after <= 0) for (const fn of this.listeners) fn();
  }
}
