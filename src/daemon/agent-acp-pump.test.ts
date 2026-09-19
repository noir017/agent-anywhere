import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpAgentFactory, TOOL_SILENCE_FACTOR } from './agent-acp.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { AgentSession, AgentStreamHandlers } from './agent.js';

/**
 * The ACP runtime's update reader, driven against a real child process.
 *
 * This is the one test that exercises the reported bug end to end, because the bug is entirely
 * about TIMING between a process and the reader: claude-agent-acp answers `session/prompt` as soon
 * as the turn's own answer is done, and keeps sending `session/update` notifications afterwards for
 * work that outlived the turn ("The consumer keeps draining afterward … forwarding any background
 * output", acp-agent.js 0.58.1). A reader that stops at the prompt response sees none of them, and
 * no amount of unit-testing the translation layer catches that — so the fake agent below reproduces
 * exactly that sequence over the wire.
 *
 * Written as a throwaway script rather than a checked-in fixture so the protocol being faked is
 * readable in one place, right next to the assertions about it.
 */

const FAKE_AGENT = /* js */ `
const readline = require('node:readline');

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (sessionId, update) =>
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

const text = (sessionId, t) =>
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
// The usage snapshot the harness ties to a completed result: 'cost' is what marks it (see
// isResultUsage), and it is how the gateway knows a burst of background output has finished.
const resultUsage = (sessionId, used) =>
  notify(sessionId, {
    sessionUpdate: 'usage_update',
    used,
    size: 200000,
    cost: { amount: 0.01, currency: 'USD' },
  });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
    return;
  }
  if (msg.method === 'session/new') {
    reply(msg.id, { sessionId: 's1' });
    return;
  }
  if (msg.method === 'session/load') {
    // What session/load does: replay the stored conversation as ordinary notifications, BEFORE
    // answering. The client attaches the session first precisely so these land in its queue.
    const sessionId = msg.params.sessionId;
    text(sessionId, 'REPLAYED HISTORY that must not be re-posted to the chat');
    notify(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'old-1',
      title: 'a tool from the previous run',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'ls' },
    });
    // A LONG history, on request. Size is the whole point: the gate that suppresses replay used to
    // be a race between the reader draining this and the turn setting its "prompted" flag, so a
    // two-message replay was always won and a real conversation's was not.
    if (sessionId.includes('long')) {
      for (let i = 0; i < 300; i++) text(sessionId, 'REPLAYED LINE ' + i);
    }
    reply(msg.id, {});
    return;
  }
  if (msg.method === 'session/cancel') {
    // A cancelled tool still reports in, and it lands after the prompt has settled.
    const sessionId = msg.params.sessionId;
    reply(msg.id, {});
    setTimeout(() => {
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'doomed-1',
        status: 'failed',
      });
    }, 40);
    return;
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const asked = JSON.stringify(msg.params.prompt ?? '');
    if (asked.includes('HANG_SILENT')) return;          // never speaks, never answers
    if (asked.includes('HANG_IN_TOOL')) {
      // Opens a tool and then goes quiet — indistinguishable from a long script.
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'slow-1',
        title: 'a very long script',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './very-long.sh' },
      });
      return;
    }
    // Every block, not just the first: the runtime prepends a reverse-CLI hint block on a
    // session's first turn, so prompt[0] is not the user's text.
    if (JSON.stringify(msg.params.prompt ?? '').includes('SLOW')) {
      // A turn that opens a tool and then waits to be cancelled.
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'doomed-1',
        title: 'a long script',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: './long.sh' },
      });
      setTimeout(() => reply(msg.id, { stopReason: 'cancelled' }), 80);
      return;
    }
    // The turn's own answer, then its result, then the prompt response — in that order, which is
    // what makes 'stop' the only safe signal that a turn's output has all been delivered.
    text(sessionId, 'started the script in the background');
    resultUsage(sessionId, 1000);
    reply(msg.id, { stopReason: 'end_turn' });
    // A trailing notification the gateway does not render, landing between the turn and the
    // background output. Kept in the fake because "an ignored update arrives mid-burst" is exactly
    // the condition under which a reader that dispatches on type can lose the updates after it.
    setTimeout(() => notify(sessionId, { sessionUpdate: 'session_info_update', title: 'The long script' }), 20);
    // ...and then the background work reporting in, with no prompt in flight. THIS is what used to
    // be dropped.
    setTimeout(() => {
      text(sessionId, 'the script finished: all green');
      resultUsage(sessionId, 1500);
    }, 60);
    return;
  }
});
`;

/** Collects everything the runtime reports, in the two channels it can report on. */
function collector(): {
  handlers: AgentStreamHandlers;
  turn: string[];
  tools: string[];
} {
  const turn: string[] = [];
  const tools: string[] = [];
  return {
    turn,
    tools,
    handlers: {
      onText: (d) => void turn.push(d),
      onToolStart: (e) => void tools.push(e.name),
      onToolFinish: () => {},
      onSegmentBreak: () => {},
    },
  };
}

let live: AgentSession | undefined;
afterEach(() => {
  live?.dispose();
  live = undefined;
});

function rig(opts: { resumeFrom?: string; turnTimeoutMs?: number } = {}): { session: AgentSession } {
  const dir = mkdtempSync(join(tmpdir(), 'aa-acp-pump-'));
  const script = join(dir, 'fake-acp-agent.cjs');
  writeFileSync(script, FAKE_AGENT);

  const parsed = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [{ id: 'fake', harness: 'custom', command: process.execPath, args: [script], cwd: dir }],
    routing: { default: 'fake', pipeline: [] },
  });
  // turnTimeoutMs is frozen in EXPERIENCE and deliberately not reachable from config.yaml, so the
  // test patches the runtime Config directly rather than pretending an operator could set it.
  const cfg: Config = opts.turnTimeoutMs
    ? { ...parsed, session: { ...parsed.session, turnTimeoutMs: opts.turnTimeoutMs } }
    : parsed;

  // Only the two members the ACP runtime asks of a store on the way up: which session to resume,
  // and where to record the new one.
  const store = {
    agentSession: () => opts.resumeFrom,
    setAgentSession: () => {},
    conversationCwd: () => undefined,
  } as unknown as Parameters<typeof createAcpAgentFactory>[2];

  const session = createAcpAgentFactory(cfg, join(dir, 'ipc.sock'), store).getOrCreate('conv#1', 'fake');
  live = session;
  return { session };
}

/** A sink that records what it is handed, shaped like the real one. */
function sinkSpy(): {
  install(session: AgentSession): void;
  text: string[];
  tools: string[];
  closes: () => number;
} {
  const text: string[] = [];
  const tools: string[] = [];
  let closes = 0;
  return {
    text,
    tools,
    closes: () => closes,
    install: (session) =>
      session.setFollowUpSink?.({
        handlers: () => ({
          onText: (d) => void text.push(d),
          onToolStart: (e) => void tools.push(e.name),
          onToolFinish: () => {},
          onSegmentBreak: () => {},
        }),
        close: () => void closes++,
      }),
  };
}

/** Wait for the fake agent's delayed notifications to arrive and be pumped. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

/** ...and then for the post-result grace window to elapse and seal the burst. */
const sealed = (): Promise<void> => new Promise((r) => setTimeout(r, 1_700));

describe('the ACP update reader keeps reading after a turn ends', () => {
  it('delivers post-turn output to the follow-up sink, not into the void', async () => {
    const { session } = rig();
    const captured: { text: string[]; closes: number } = {
      text: [],
      closes: 0,
    };
    session.setFollowUpSink?.({
      handlers: () => ({
        onText: (d) => void captured.text.push(d),
        onToolStart: () => {},
        onToolFinish: () => {},
        onSegmentBreak: () => {},
      }),
      close: () => void captured.closes++,
    });

    const turn = collector();
    await session.runTurn({ prompt: 'run the long script', sessionToken: 'tok' }, turn.handlers);

    // The turn resolved on its own answer only — the background work has not reported yet.
    expect(turn.turn.join('')).toBe('started the script in the background');
    expect(captured.text).toEqual([]);

    await settle();

    // The whole point: output produced after the turn settled reached the conversation.
    expect(captured.text.join('')).toBe('the script finished: all green');
    // Not sealed yet — the result marker only shortens the timer, because `usage_update.cost` is
    // documented as a cumulative total and a harness may report it on every snapshot.
    expect(captured.closes).toBe(0);

    await sealed();

    // And the burst IS eventually closed, which is what makes it visible at all in the default
    // `once` delivery mode (nothing is sent until the buffer completes).
    expect(captured.closes).toBe(1);
  });

  it('routes a later turn\'s output back to that turn, not to the sink', async () => {
    const { session } = rig();
    const strayed: string[] = [];
    session.setFollowUpSink?.({
      handlers: () => ({
        onText: (d) => void strayed.push(d),
        onToolStart: () => {},
        onToolFinish: () => {},
        onSegmentBreak: () => {},
      }),
      close: () => {},
    });

    await session.runTurn({ prompt: 'first', sessionToken: 'tok' }, collector().handlers);
    await settle();
    strayed.length = 0;

    // The handover a between-turns drain could not do safely: the SDK's queue has exactly one
    // reader, and an abandoned waiter still swallows the next value that arrives.
    const second = collector();
    await session.runTurn({ prompt: 'second', sessionToken: 'tok' }, second.handlers);
    expect(second.turn.join('')).toBe('started the script in the background');
    expect(strayed).toEqual([]);
  });
});

/**
 * Two things the old pre-prompt drain was quietly doing, which a permanent reader has to do
 * deliberately instead. Both were caught by review rather than by use, and both would have been
 * embarrassing in production: one re-narrates your previous conversation on every restart, the
 * other answers `/stop` with a bubble for the tool you just stopped.
 */
describe('what must NOT be rendered as background output', () => {
  it('does not re-post the history that session/load replays', async () => {
    const { session } = rig({ resumeFrom: 'stored-session-id' });
    const sink = sinkSpy();
    sink.install(session);

    // The replay is emitted during startup, i.e. before this turn's prompt is even sent.
    const turn = collector();
    await session.runTurn({ prompt: 'carry on', sessionToken: 'tok' }, turn.handlers);
    await settle();

    const everything = [...sink.text, ...turn.turn].join(' ');
    expect(everything).not.toContain('REPLAYED HISTORY');
    expect(sink.tools).not.toContain('Bash'); // the replayed tool_call must not open a bubble either
    // ...and the live turn is unaffected: its own answer still arrives.
    expect(turn.turn.join('')).toBe('started the script in the background');
  });

  it('does not re-post a LONG replayed history either — the case the old gate lost', async () => {
    // The regression, 2026-09-11: on a conversation with hours of history, a daemon restart
    // re-sent the whole thing to Telegram as one turn's reply. The suppression gate was a race —
    // the reader dropped whatever it reached before runTurn set the "prompted" flag (five updates,
    // in the live incident) and rendered everything after. Two replayed messages always won that
    // race, which is why the test above passed throughout. Three hundred do not.
    const { session } = rig({ resumeFrom: 'stored-session-id-long' });
    const sink = sinkSpy();
    sink.install(session);

    const turn = collector();
    await session.runTurn({ prompt: 'carry on', sessionToken: 'tok' }, turn.handlers);
    await settle();

    const everything = [...sink.text, ...turn.turn].join(' ');
    expect(everything).not.toContain('REPLAYED HISTORY');
    expect(everything).not.toContain('REPLAYED LINE');
    // The live turn is still delivered in full — the fence delays the flag, it does not swallow
    // this turn's own output.
    expect(turn.turn.join('')).toBe('started the script in the background');
  });

  it('drops a cancelled tool\'s trailing update instead of opening a follow-up for it', async () => {
    const { session } = rig();
    const sink = sinkSpy();
    sink.install(session);

    const turn = collector();
    const running = session.runTurn({ prompt: 'SLOW: run the long script', sessionToken: 'tok' }, turn.handlers);
    // Wait for the tool to actually be RUNNING rather than for a wall-clock guess: the child has
    // to spawn and handshake first, and a fixed sleep here was long enough to abort before the
    // ledger had anything in it — which is a real window the runtime has to cover too.
    for (let i = 0; i < 200 && turn.tools.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(turn.tools).toEqual(['Bash']); // the turn itself did render the tool it was running
    session.abort();
    await running;
    await settle();

    // The trailing `tool_call_update` for the killed tool arrived with no turn running; rendering
    // it would have posted a "background update" about the tool the user just stopped.
    expect(sink.tools).toEqual([]);
    expect(sink.closes()).toBe(0);
  });
});

/**
 * The silence watchdog has to separate "wedged" from "running a long script", and those look
 * identical from outside: a tool call emits nothing for exactly as long as it takes. The collision
 * was guaranteed rather than unlucky — Claude Code's Bash tool allows up to 600000ms, which is
 * precisely the watchdog's default — so a tool call at the harness's own limit failed the turn with
 * "sent no update for 600000ms" while the script was still running fine.
 */
describe('the silence watchdog distinguishes a hang from a long tool call', () => {
  const TIMEOUT = 200;

  it('fails a turn that goes quiet with nothing running', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const started = Date.now();
    await expect(
      session.runTurn({ prompt: 'HANG_SILENT', sessionToken: 'tok' }, collector().handlers)
    ).rejects.toThrow(/sent no update/);
    // Failed on the FIRST deadline: no tool was open, so no grace was owed.
    expect(Date.now() - started).toBeLessThan(TIMEOUT * TOOL_SILENCE_FACTOR);
  });

  it('gives a turn with an open tool call more time, then still fails it', async () => {
    const { session } = rig({ turnTimeoutMs: TIMEOUT });
    const started = Date.now();
    await expect(
      session.runTurn({ prompt: 'HANG_IN_TOOL', sessionToken: 'tok' }, collector().handlers)
    ).rejects.toThrow(/tool call still open/);
    // Past the first deadline — the tool bought it the extension...
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT * (1 + TOOL_SILENCE_FACTOR));
    // ...but the ceiling is finite, which is what keeps a wedged tool from pinning the
    // conversation in `running` forever.
  });
});
