import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAcpAgentFactory } from './agent-acp.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { AgentStreamHandlers } from './agent.js';
import type { ElicitAnswer } from '../types.js';

/**
 * ACP elicitation against a real child process: the handshake advertises the capability, an
 * `elicitation/create` the agent sends mid-turn reaches the turn's onElicit, the answer goes back
 * over the wire — and the silence watchdog does not kill the turn while the user is deciding.
 *
 * That last one is the reason this drives a process at all: the watchdog races the agent's update
 * stream, and an agent blocked on a person sends nothing, so only a real silent peer shows whether
 * the race is settled correctly. The fake agent below is raw JSON-RPC so the protocol being faked
 * is readable in one place, next to the assertions about it.
 */

const FAKE_AGENT = /* js */ `
const readline = require('node:readline');
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let caps = null;
let promptId = null;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    caps = msg.params.clientCapabilities;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, agentCapabilities: {} } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S1' } });
  } else if (msg.method === 'session/prompt') {
    promptId = msg.id;
    // Shape of claude-agent-acp's AskUserQuestion bridge: one question_<n> field, oneOf options.
    send({ jsonrpc: '2.0', id: 900, method: 'elicitation/create', params: {
      mode: 'form', sessionId: 'S1', message: 'Which database?',
      requestedSchema: { type: 'object', properties: {
        question_0: { type: 'string', oneOf: [{ const: 'pg', title: 'Postgres' }, { const: 'my', title: 'MySQL' }] },
        question_0_custom: { type: 'string', title: 'Other' },
      } },
    } });
  } else if (msg.id === 900 && promptId !== null) {
    // The client's answer: echo what it advertised and what it answered, then end the turn.
    const text = JSON.stringify({ elicitation: caps && caps.elicitation, answer: msg.result });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S1', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`;

let dir: string;
const savedConfigDir = process.env.AGENT_ANYWHERE_CONFIG_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aa-elicit-'));
  writeFileSync(join(dir, 'fake-agent.cjs'), FAKE_AGENT);
  // ensureStarted provisions the reverse-CLI shim under configDir()/bin. Point that at the temp dir:
  // the real one is shared with whatever daemon runs on this machine, and this test must not
  // repoint its agents' `agent-anywhere` at a vitest worker.
  process.env.AGENT_ANYWHERE_CONFIG_DIR = dir;
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.AGENT_ANYWHERE_CONFIG_DIR;
  else process.env.AGENT_ANYWHERE_CONFIG_DIR = savedConfigDir;
});

function config(turnTimeoutMs: number): Config {
  const base = parseConfig({
    platforms: { p: { type: 'discord', token: 't' } },
    agents: [{ id: 'fake', harness: 'custom', command: process.execPath, args: [join(dir, 'fake-agent.cjs')], cwd: dir }],
    routing: { default: 'fake' },
  });
  return { ...base, session: { ...base.session, turnTimeoutMs } };
}

async function runOneTurn(cfg: Config, onElicit?: AgentStreamHandlers['onElicit']): Promise<string> {
  const factory = createAcpAgentFactory(cfg, join(dir, 'unused.sock'));
  const session = factory.getOrCreate('s1', 'fake');
  let text = '';
  try {
    await session.runTurn(
      { prompt: 'hi', sessionToken: 'tok' },
      {
        onText: (d) => { text += d; },
        onToolStart: () => {},
        onToolFinish: () => {},
        onSegmentBreak: () => {},
        ...(onElicit ? { onElicit } : {}),
      }
    );
  } finally {
    factory.dispose('s1');
  }
  return text;
}

describe('ACP elicitation over a real connection', () => {
  it('advertises form elicitation as an object and carries the answer back', async () => {
    const text = await runOneTurn(config(0), async (req) => {
      expect(req.questions.map((q) => q.options.map((o) => o.label))).toEqual([['Postgres', 'MySQL']]);
      return { action: 'accept', content: { question_0: 'pg' } };
    });
    expect(JSON.parse(text)).toEqual({
      // `{}`, not `true`: opencode rejects a boolean here and fails the whole initialize.
      elicitation: { form: {} },
      answer: { action: 'accept', content: { question_0: 'pg' } },
    });
  });

  it('the silence watchdog waits for the user instead of aborting the turn as hung', async () => {
    // The user takes 2.5× the watchdog's budget to answer; the agent sends nothing meanwhile. The
    // budget itself is generous because the stretch BEFORE the question arrives is ordinary
    // silence and is still watched — under a loaded test run that gap alone can exceed 150 ms.
    const answer: ElicitAnswer = { action: 'accept', content: { question_0: 'my' } };
    const text = await runOneTurn(config(1_000), () => new Promise((r) => setTimeout(() => r(answer), 2_500)));
    expect(JSON.parse(text).answer).toEqual(answer);
  });

  it('a turn with no way to ask cancels, rather than answering for the user', async () => {
    const text = await runOneTurn(config(0));
    expect(JSON.parse(text).answer).toEqual({ action: 'cancel' });
  });
});
