import { describe, expect, it } from 'vitest';
import { ConversationRegistry } from './conversation.js';
import { parseConfig, type Config } from '../config/schema.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { AgentFactory, AgentSession } from './agent.js';
import type { ConversationId, InboundMessage } from '../types.js';

/**
 * Generic-command interception in SessionRegistry.route().
 *
 * These pin the behavior of a real two-harness deployment (`cc` = claude, `oc` = opencode), where
 * registering the union of agent-reported commands misfired three ways: the menu flipped to
 * whichever agent answered last, same-named commands from different harnesses collided, and an
 * agent-specific command invoked from the menu ran on `routing.default` instead of the agent that
 * offered it.
 *
 * The assertions that matter are the negative ones — a rejected command must NOT reach the merger
 * and must NOT emit a header, because both would announce a turn that never happens.
 *
 * Configs go through the real parseConfig rather than a hand-built object: the runtime reads keys
 * (stream/tools/inbound) that only the schema's defaults supply, so a literal would silently differ
 * from what the daemon actually runs.
 */

/** Build a runtime Config from the user-facing subset, exactly as loading a config.yaml would. */
const makeConfig = (over: Record<string, unknown> = {}): Config => {
  const cfg = parseConfig({
    platforms: { discord: { type: 'discord', token: 't' } },
    agents: [
      { id: 'cc', harness: 'claude' },
      { id: 'oc', harness: 'opencode' },
    ],
    routing: {
      default: 'cc',
      pipeline: [
        { when: { command: 'oc' }, use: { agent: 'oc' } },
        { when: { command: 'cc' }, use: { agent: 'cc' } },
      ],
    },
    display: { header: { enabled: true } },
    ...over,
  });
  // Shrink the merge window so a routed message dispatches promptly. Applied to the PARSED object
  // rather than the input: `inbound` belongs to the frozen EXPERIENCE block, which parseConfig
  // spreads over the user config, so passing it above would be silently discarded.
  return { ...cfg, inbound: { ...cfg.inbound, mergeWindowMs: 1, maxMergeWindowMs: 1 } };
};

const baseConfig = makeConfig();

/**
 * The conversation every rig message belongs to. Note what is NOT in it: an agent id. Under the
 * old scheme this was `cc:discord:c:c1` or `oc:discord:c:c1` depending on who answered, which is
 * exactly why `/oc hi` followed by a plain message produced two conversations in one place.
 */
const KEY = 'discord#c1';

/**
 * Real timers, with the merge window set to 0 in config below so a routed message dispatches on the
 * next tick. Firing every scheduled callback inline is not an option: the typing keep-alive
 * re-schedules itself, so it would recurse until the stack blew.
 */
const clock = {
  now: () => Date.now(),
  schedule: (fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** Let the merge window elapse and the turn reach the agent stub. */
const drain = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Rig: records outbound text, the prompts that reached an agent, and picker hook calls. */
function rig(cfg: Config = baseConfig) {
  const prompts: Array<{ sessionId: string; prompt: string }> = [];
  const sessions = new Map<string, AgentSession>();
  const factory: AgentFactory = {
    getOrCreate(conversationId) {
      let s = sessions.get(conversationId);
      if (!s) {
        s = {
          conversationId,
          runTurn: async (input) => {
            prompts.push({ sessionId: conversationId, prompt: input.prompt });
          },
          abort: () => {},
          dispose: () => {},
        };
        sessions.set(conversationId, s);
      }
      return s!;
    },
    dispose: (id) => void sessions.delete(id),
  };

  const sent: string[] = [];
  const platform = {
    capabilities: { thread: false, editMessage: true },
    sendMessage: async (address: { channel: string }, text: string) => {
      sent.push(text);
      return { address, messageId: 'm1' };
    },
    editMessage: async () => {},
    addReaction: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    measureRendered: (t: string) => t.length,
  } as unknown as PlatformAdapter;

  const pickerCalls: Array<{ sessionId: ConversationId; agentId: string }> = [];
  const reg = new ConversationRegistry(
    cfg,
    new Map([['discord', platform]]),
    factory,
    clock,
    { onPickerRequest: (sessionId, agentId) => void pickerCalls.push({ sessionId, agentId }) },
    // Store stub: no persisted bindings, and writes are ignored.
    {
      boundAgent: () => undefined,
      bind: () => {},
      agentSession: () => undefined,
      setAgentSession: () => {},
      clear: () => {},
    } as never
  );

  let n = 0;
  /**
   * Route one message and let the turn reach the agent. TurnRunner awaits several times before
   * calling runTurn (channel resolution, attachment ingest), so the synchronous route() call alone
   * would finish before any prompt is recorded.
   */
  const send = async (content: string): Promise<void> => {
    reg.route({
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: `m${++n}`,
      content,
      timestamp: 0,
    } as InboundMessage);
    await drain();
  };

  const headers = (): string[] => sent.filter((t) => t.startsWith('🤖'));
  return { reg, sent, send, prompts, pickerCalls, headers };
}

describe('generic command translation in route()', () => {
  it('rejects a generic command the target harness has no equivalent for, without running a turn', async () => {
    const { send, sent, prompts, headers } = rig();
    // Probed live: opencode reports only customize-opencode/init/review — no compact.
    await send('/oc /compact');
    expect(sent.some((t) => t.includes('does not support /compact'))).toBe(true);
    // The two negatives that matter: no turn, and no header announcing one.
    expect(prompts).toEqual([]);
    expect(headers()).toEqual([]);
  });

  it('names the harness (not the config id) and points at its own command list', async () => {
    const { send, sent } = rig();
    await send('/oc /model');
    const msg = sent.find((t) => t.includes('does not support'))!;
    // `oc` is an operator's typing shorthand and means nothing to a reader.
    expect(msg).toContain('opencode does not support /model');
    expect(msg).toContain('/opencode');
  });

  it('forwards a supported generic command to the routed agent', async () => {
    const { send, prompts } = rig();
    await send('/cc /compact');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY);
    expect(prompts[0]!.prompt).toContain('/compact');
  });

  it('a plain generic command follows normal routing (routing.default), like any other message', async () => {
    const { send, prompts } = rig();
    await send('/compact');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY); // answered by routing.default, in the same conversation
  });

  it('passes through harness-specific commands typed directly', async () => {
    const { send, prompts } = rig();
    await send('/oc /customize-opencode');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY);
    expect(prompts[0]!.prompt).toContain('/customize-opencode');
  });

  it('rewrites to the native spelling where the harness differs, keeping the argument', async () => {
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [{ id: 'gm', harness: 'gemini', args: [], env: {} }],
      routing: { default: 'gm', pipeline: [] },
    } as unknown as Config;
    const { send, prompts } = rig(cfg);
    await send('/compact please');
    // gemini spells it `compress`; the argument survives the rewrite.
    expect(prompts[0]!.prompt).toContain('/compress please');
    expect(prompts[0]!.prompt).not.toContain('/compact');
  });

  it('leaves ordinary messages untouched', async () => {
    const { send, prompts } = rig();
    await send('hello there');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toContain('hello there');
  });

  it('still intercepts /new before translation (daemon commands win)', async () => {
    const { send, prompts, sent } = rig();
    await send('/new');
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('Context cleared'))).toBe(true);
  });
});

describe('harness picker in route()', () => {
  it('invoked in a session of that harness → hands off to the daemon with that session', async () => {
    const { send, pickerCalls, prompts } = rig();
    await send('/cc /claude');
    expect(pickerCalls).toEqual([{ sessionId: KEY, agentId: 'cc' }]);
    expect(prompts).toEqual([]); // the picker is UI, never a prompt
  });

  it('invoked in a session of a DIFFERENT harness → reports it does not apply, runs nothing', async () => {
    const { send, sent, pickerCalls, prompts } = rig();
    await send('/oc /claude');
    expect(pickerCalls).toEqual([]);
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('answered by opencode'))).toBe(true);
  });

  it('a picker for an unconfigured harness is not special (falls through as a normal command)', async () => {
    const cfg = {
      ...(baseConfig as unknown as Record<string, unknown>),
      agents: [{ id: 'cc', harness: 'claude', args: [], env: {} }],
      routing: { default: 'cc', pipeline: [] },
    } as unknown as Config;
    const { send, pickerCalls, prompts } = rig(cfg);
    await send('/opencode'); // opencode isn't configured here
    expect(pickerCalls).toEqual([]);
    expect(prompts).toHaveLength(1);
  });
});

describe('dispatchTo', () => {
  it('delivers to the named conversation, bypassing routing', async () => {
    const { reg, send, prompts } = rig();
    await send('/oc hello'); // bind this conversation to oc
    prompts.length = 0;

    // A bare /init carries no agent prefix, so re-routing it would resolve against the pipeline
    // instead of the conversation's bound agent — the misdelivery this path removes.
    const ok = reg.dispatchTo(KEY, {
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: 'click',
      content: '/init',
      timestamp: 0,
    } as InboundMessage);

    expect(ok).toBe(true);
    await drain(); // the merger dispatches on its own window, as for any inbound
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.sessionId).toBe(KEY);
    expect(prompts[0]!.prompt).toContain('/init');
  });

  it('reports failure for an unknown conversation instead of dropping the message', async () => {
    const { reg } = rig();
    const ok = reg.dispatchTo('discord#nope', {
      conversation: { platform: 'discord', channel: 'c1', kind: 'direct', user: 'u1' },
      messageId: 'click',
      content: '/init',
      timestamp: 0,
    } as InboundMessage);
    expect(ok).toBe(false);
  });
});

/**
 * THE reported bug, pinned end to end.
 *
 * Screenshot: in one Telegram topic, `/oc hi` was answered by opencode and the very next plain
 * message by claude. Cause: the agent id led the session key AND the pipeline was re-resolved on
 * every message, so a follow-up that matched no rule fell through to routing.default and computed
 * a different key — a different subprocess with empty context.
 *
 * These assert the two halves of the fix together: one conversation key throughout, and the bound
 * agent answering until the user explicitly names another.
 */
describe('sticky agent binding (the reported bug)', () => {
  it('a plain follow-up stays with the agent the conversation was bound to', async () => {
    const { send, prompts } = rig();

    await send('/oc hi');
    await send('second turn');

    expect(prompts).toHaveLength(2);
    // Same conversation both times — this is what used to differ.
    expect(prompts.map((p) => p.sessionId)).toEqual([KEY, KEY]);
    // And the same agent process serves both, so the second turn has the first one's context.
    expect(prompts[1]!.prompt).toContain('second turn');
  });

  it('an explicit /name rebinds, and the next plain message follows the NEW agent', async () => {
    const { send, prompts, sent } = rig();

    await send('/oc hi');
    await send('/cc take over');
    await send('still you');

    expect(prompts.map((p) => p.sessionId)).toEqual([KEY, KEY, KEY]);
    expect(sent.some((t) => t.includes('is answering this conversation now'))).toBe(true);
  });

  it('a bare /name is a binding instruction, not an empty prompt', async () => {
    const { send, prompts, sent } = rig();
    await send('/oc');
    // No turn: there is nothing to say yet.
    expect(prompts).toEqual([]);
    expect(sent.some((t) => t.includes('answered by opencode'))).toBe(true);
  });

  it('the conversation key never contains an agent id', async () => {
    const { send, prompts } = rig();
    await send('/oc hi');
    await send('/cc hi');
    for (const p of prompts) {
      expect(p.sessionId).toBe(KEY);
      expect(p.sessionId).not.toMatch(/\b(oc|cc)\b/);
    }
  });
});
