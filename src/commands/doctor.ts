import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveSocketPath, configPath, readRawConfigIfExists, saveConfig } from '../config/load.js';
import { ConfigSchema, accessUnrestricted, platformInstances, type Config } from '../config/schema.js';
import { isLegacyConfig, migrateLegacyConfig } from '../config/migrate.js';
import { resolveClaudeAdapterEntry, resolveCodexAdapterEntry } from '../daemon/agent-acp.js';
import { AGY_COMMAND } from '../daemon/agent-agy.js';

/**
 * Locate an executable: if it contains a path separator, check the file directly;
 * otherwise scan PATH. Returns the path, or null if not found.
 */
function locateCommand(cmd: string): string | null {
  if (cmd.includes('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* command not in this dir, continue */
    }
  }
  return null;
}

/** Agent definition -> its harness's main executable name (doctor only checks reachability, same convention as agent-acp's resolveHarness / agent-agy's AGY_COMMAND). claude/codex are handled separately (local dependencies, not PATH). */
function harnessCommand(def: import('../config/schema.js').AgentDef): string {
  switch (def.harness) {
    case 'claude':
      return 'claude-agent-acp';
    case 'gemini':
      return 'gemini';
    case 'codex':
      return 'codex-acp';
    case 'opencode':
      return 'opencode';
    case 'agy':
      return AGY_COMMAND;
    case 'custom':
      return def.command ?? '(custom harness: no command configured)';
  }
}

/** Whether a local adapter dependency resolves (claude/codex harnesses spawn a dependency, not a PATH command). */
function adapterResolves(resolve: () => string): boolean {
  try {
    resolve();
    return true;
  } catch {
    return false;
  }
}

/**
 * Auth-method note. harness=claude (claude-agent-acp) by default reuses this machine's
 * `claude /login` subscription session; if ANTHROPIC_API_KEY is set (via env or
 * environment) it uses an API key. harness=agy reuses the Google sign-in `agy` cached in the OS
 * keyring — headless runs never prompt, so a never-signed-in agy fails at the first turn, and
 * saying so here is the only warning the operator gets. Other harnesses aren't noted (own mechanisms).
 */
function authNote(def: import('../config/schema.js').AgentDef): string {
  if (def.harness === 'agy') return ' [agy Google sign-in from the OS keyring; run `agy` once interactively if never signed in]';
  if (def.harness !== 'claude') return '';
  const hasKey = Boolean(def.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
  return hasKey ? ' [API key]' : ' [claude /login subscription session]';
}

/**
 * `agent-anywhere doctor` — self-check. Each item reports ✅/⚠️/❌; doesn't exit on the first
 * failure, summarizes after running all.
 */
interface Check {
  name: string;
  run(): Promise<{ ok: boolean; level?: 'warn'; detail?: string }>;
}

/**
 * Try connecting to the socket to see if a daemon is actually listening.
 * Connect ok -> true (daemon running); ECONNREFUSED/timeout -> false (stale or nobody listening).
 */
function probeDaemon(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection(socketPath);
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(alive);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** Validate a Discord token: GET /users/@me; 200 yields the bot name, 401 means invalid. */
async function checkDiscordToken(
  token: string
): Promise<{ ok: boolean; level?: 'warn'; detail?: string }> {
  try {
    const resp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (resp.status === 200) {
      const me = (await resp.json()) as { username?: string; id?: string };
      const name = me.username ?? me.id ?? '(unknown)';
      return { ok: true, detail: `bot username: ${name}` };
    }
    if (resp.status === 401) {
      return { ok: false, detail: 'invalid token (401 Unauthorized)' };
    }
    return { ok: false, detail: `Discord returned an unexpected status ${resp.status}` };
  } catch (e) {
    // Network errors etc. aren't treated as an invalid token; degrade to warn.
    return {
      ok: true,
      level: 'warn',
      detail: `could not reach Discord to validate the token: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Collapse the user's home dir to `~` for a compact, portable bin path (AXI §10). */
function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** AXI §10: identify the tool before the live data — absolute bin path + one-line description. */
function printIdentity(): void {
  console.log(`bin: ${tildify(process.argv[1] ?? 'agent-anywhere')}`);
  console.log(`config: ${tildify(configPath())}`);
  console.log('description: Gateway connecting IM platforms to coding agents; this is its self-check.');
}

/**
 * `doctor --migrate-config`: rewrite a v0 file to v1 on disk. Validates the migrated
 * shape BEFORE touching the file, backs up to <file>.bak, then does a full rewrite
 * (comments are lost — noted in the output; the in-memory migration path never
 * touches the file, so opting into the rewrite is explicit).
 */
function migrateConfigFile(): void {
  const p = configPath();
  const raw = readRawConfigIfExists();
  if (!raw) {
    console.log(`❌ cannot read ${p} (missing or unparseable); nothing to migrate`);
    process.exitCode = 1;
    return;
  }
  if (!isLegacyConfig(raw)) {
    console.log(`✅ ${p} is already in the v1 format (platforms: map); nothing to do`);
    return;
  }
  const { config, notes } = migrateLegacyConfig(raw);
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    console.log(`❌ migrated config does not validate; file left untouched:\n${lines.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(p, `${p}.bak`);
  // Write the SLIM migrated raw (validated above), not parsed.data — parsing materializes
  // every schema default and would bloat the file with values the user never set.
  saveConfig(config as unknown as Parameters<typeof saveConfig>[0]);
  console.log(`✅ migrated ${p} to the v1 format (backup at ${p}.bak; YAML comments were not preserved)`);
  for (const n of notes) console.log(`   - ${n}`);
}

export async function runDoctor(opts: { migrateConfig?: boolean } = {}): Promise<void> {
  if (opts.migrateConfig) {
    migrateConfigFile();
    return;
  }

  printIdentity();

  // Load config once and reuse it across checks; if loading fails, dependent checks degrade themselves.
  let cfg: Config | null = null;
  let cfgError: string | null = null;
  try {
    cfg = loadConfig();
  } catch (e) {
    cfgError = String(e instanceof Error ? e.message : e);
  }

  // Cache the Discord token result for the "platform adapter connectivity (placeholder)" check (only the discord path writes it).
  let discordResult: { ok: boolean; level?: 'warn'; detail?: string } | null = null;

  const checks: Check[] = [
    {
      name: 'Config file exists and is valid',
      run: async () => {
        if (cfg) return { ok: true };
        return { ok: false, detail: cfgError ?? 'unknown error' };
      },
    },
    {
      // One daemon drives every configured instance; list them for a quick sanity read.
      name: 'Platform instances',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot resolve platform instances' };
        const insts = platformInstances(cfg);
        return { ok: true, detail: insts.map((i) => `"${i.id}" (${i.type})`).join(', ') };
      },
    },
    {
      // Platform credential check per instance. Required credentials are already
      // schema-validated at load (typed per-platform schemas), so only ONLINE validation
      // remains: discord hits /users/@me; other platforms have none implemented yet.
      name: 'Platform credentials usable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot read credentials' };
        const lines: string[] = [];
        let anyFail = false;
        let anyWarn = false;
        for (const [id, p] of Object.entries(cfg.platforms)) {
          if (p.type === 'discord') {
            discordResult = await checkDiscordToken(p.token);
            if (!discordResult.ok) anyFail = true;
            else if (discordResult.level === 'warn') anyWarn = true;
            lines.push(`${id}: ${discordResult.detail ?? (discordResult.ok ? 'ok' : 'failed')}`);
          } else {
            anyWarn = true;
            lines.push(
              `${id} (${p.type}): credentials schema-validated; online validation not implemented — if start fails to connect, re-check them`
            );
          }
        }
        return { ok: !anyFail, ...(anyWarn && !anyFail ? { level: 'warn' as const } : {}), detail: lines.join('; ') };
      },
    },
    {
      // Adapter connectivity placeholder: only discord shows an honest "no gateway
      // actually established" placeholder; other platforms skip this check (avoiding a
      // misleading Discord-specific placeholder).
      name: 'Platform adapter connectivity (placeholder)',
      run: async () => {
        const types = cfg ? Object.values(cfg.platforms).map((p) => p.type) : [];
        if (!types.includes('discord')) {
          // Non-discord has no online placeholder check; pass and explain why it's skipped.
          return { ok: true, detail: `${types.join(',') || '(unknown)'} skipped (no online connectivity placeholder)` };
        }
        // discord: don't actually start a gateway; token validation already covers most connectivity (same bot credential).
        if (discordResult?.ok) {
          return {
            ok: true,
            level: 'warn',
            detail: 'placeholder: no gateway was actually established; the token check already covers most connectivity',
          };
        }
        return {
          ok: true,
          level: 'warn',
          detail: 'placeholder: no gateway was actually established; the token check failed, so the adapter most likely cannot connect',
        };
      },
    },
    {
      // Security posture: agents always run with full tool access, so an empty access.allowFrom
      // means anyone who can message the bot can drive them. Surface it as a standing ⚠️.
      name: 'Security: access control',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check access control' };
        if (!accessUnrestricted(cfg)) {
          return { ok: true, detail: `access.allowFrom restricts triggering to ${cfg.access.allowFrom.length} identity(ies)` };
        }
        return {
          ok: true,
          level: 'warn',
          detail:
            'access.allowFrom is empty: ANYONE who can message the bot can trigger an agent with full ' +
            'tool access (Bash / file writes). Set access.allowFrom to lock this down for production.',
        };
      },
    },
    {
      name: 'ACP SDK installed',
      run: async () => {
        const sdkName = '@agentclientprotocol/sdk';
        try {
          await import(sdkName);
          return { ok: true, detail: `${sdkName} loads successfully` };
        } catch {
          return { ok: false, detail: `${sdkName} is not installed — run npm i first` };
        }
      },
    },
    {
      name: 'Agent harness commands reachable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot check agents' };
        const lines: string[] = [];
        let anyMissing = false;
        for (const def of cfg.agents) {
          const cmd = harnessCommand(def);
          const auth = authNote(def);
          // claude/codex run locally installed adapter dependencies (claude-agent-acp / Zed's
          // codex-acp native binary), so the check is "does the dependency resolve", not a PATH
          // lookup. Whether they can actually log in is covered by authNote.
          const found =
            def.harness === 'claude'
              ? adapterResolves(resolveClaudeAdapterEntry)
              : def.harness === 'codex'
                ? adapterResolves(resolveCodexAdapterEntry)
                : Boolean(locateCommand(cmd));
          const note =
            (def.harness === 'claude' || def.harness === 'codex') && !found
              ? ' (dependency missing — run npm install)'
              : '';
          if (found) {
            lines.push(`${def.id} (${def.harness}) → ${cmd} ✓${auth}`);
          } else {
            anyMissing = true;
            lines.push(`${def.id} (${def.harness}) → ${cmd} ✗ not found${note}`);
          }
        }
        // A fully missing command means the agent subprocess can't launch at start -> escalate to ❌ (so the exit code reflects it), not warn.
        return anyMissing
          ? { ok: false, detail: `some harness commands are not on PATH: ${lines.join('; ')}` }
          : { ok: true, detail: lines.join('; ') };
      },
    },
    {
      name: 'IPC socket path usable',
      run: async () => {
        if (!cfg) return { ok: false, detail: 'config unavailable, cannot resolve socket path' };
        try {
          const sock = resolveSocketPath(cfg);
          if (fs.existsSync(sock)) {
            // Socket file exists: probe to distinguish "daemon running" from "stale file".
            const alive = await probeDaemon(sock);
            if (alive) {
              return { ok: true, level: 'warn', detail: `${sock} (a daemon is listening)` };
            }
            return {
              ok: true,
              level: 'warn',
              detail: `${sock} exists but nothing is listening (stale file; the daemon cleans it up on start)`,
            };
          }
          return { ok: true, detail: sock };
        } catch (e) {
          return { ok: false, detail: String(e) };
        }
      },
    },
  ];

  let failed = false;
  for (const c of checks) {
    const r = await c.run();
    const icon = r.ok ? (r.level === 'warn' ? '⚠️ ' : '✅') : '❌';
    if (!r.ok) failed = true;
    console.log(`${icon} ${c.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  if (failed) process.exitCode = 1;
}
