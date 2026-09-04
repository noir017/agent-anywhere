import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import {
  ConfigSchema,
  accessUnrestricted,
  withExperienceDefaults,
  type Config,
  type UserConfig,
} from './schema.js';
import { expandEnvVars, loadDotEnv } from './env-expand.js';
import { isLegacyConfig, migrateLegacyConfig } from './migrate.js';

/**
 * Directory that holds the config file, socket, and other per-instance state.
 * Precedence (highest first):
 *   1. AGENT_ANYWHERE_CONFIG_FILE — an explicit config file path; its parent dir is used here.
 *   2. AGENT_ANYWHERE_CONFIG_DIR  — a config directory (config.yaml lives inside).
 *   3. default ~/.config/agent-anywhere/
 * The `--config <path>` CLI flag is plumbed through by setting AGENT_ANYWHERE_CONFIG_FILE on
 * process.env, so it is inherited by the agent subprocess (and thus by reverse commands).
 */
export function configDir(): string {
  const file = process.env.AGENT_ANYWHERE_CONFIG_FILE;
  if (file) return path.dirname(path.resolve(expandHome(file)));
  return process.env.AGENT_ANYWHERE_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'agent-anywhere');
}

/** Absolute path of the active config file. AGENT_ANYWHERE_CONFIG_FILE overrides the default config.yaml. */
export function configPath(): string {
  const file = process.env.AGENT_ANYWHERE_CONFIG_FILE;
  if (file) return path.resolve(expandHome(file));
  return path.join(configDir(), 'config.yaml');
}

export function defaultSocketPath(): string {
  return path.join(configDir(), 'daemon.sock');
}

/**
 * Expand a leading `~` (`~` or `~/...`) to the user's home dir. A `~` elsewhere
 * (e.g. `a/~/b`) is not expanded, matching shell semantics. Used uniformly by fields
 * that accept user-written paths — currently agents[].cwd (daemon-side) and
 * ipc.socketPath / attachments.cacheDir.
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function loadConfig(): Config {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(`config not found at ${p}; run \`agent-anywhere setup\` first`);
  }
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to parse config file (YAML) ${p}: ${msg}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`config file is empty or malformed ${p}; run \`agent-anywhere setup\` to regenerate it`);
  }

  // v0 (single `platform:` object) → v1 in memory; the file itself is left untouched.
  if (isLegacyConfig(raw)) {
    raw = migrateLegacyConfig(raw as Record<string, unknown>).config;
    console.warn(
      `[config] ⚠️  ${p} uses the old single-platform format; it was migrated in memory. ` +
        'Run `agent-anywhere doctor --migrate-config` to rewrite the file to the v1 `platforms:` map.'
    );
  }

  // ${VAR} expansion: .env sidecar fills gaps in process.env first, then every string
  // in the tree is expanded. This happens on a load-time copy only — the raw file
  // (and anything setup/saveConfig touch) keeps the ${VAR} templates, so expanded
  // secrets are never written back to disk.
  loadDotEnv(configDir());
  raw = expandEnvVars(raw);

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    // Aggregate all issues into one message so the user can fix everything at once.
    const lines = result.error.issues.map((i) => {
      const where = i.path.join('.') || '(root)';
      return `  - ${where}: ${i.message}`;
    });
    throw new Error(`config validation failed ${p}:\n${lines.join('\n')}\nrun \`agent-anywhere setup\``);
  }
  // The file only carries the slim user surface; merge in the frozen experience defaults.
  const cfg = withExperienceDefaults(result.data);

  // Security warning (non-blocking): agents always run with full tool access (Bash / file writes),
  // so an empty access.allowFrom means anyone who can message the bot can drive them with no
  // authorization gate. Warn loudly but start anyway — set access.allowFrom to lock it down.
  if (accessUnrestricted(cfg)) {
    console.warn(
      '[config] ⚠️  access.allowFrom is empty: anyone who can message the bot can trigger an agent ' +
        'with full tool access (Bash / file writes). Set access.allowFrom (e.g. ["discord:123456789"]) ' +
        'to restrict who can trigger it in any shared/public deployment.'
    );
  }
  return cfg;
}

/** Read the existing raw config object (before schema defaults); undefined if missing or unparseable. Used by setup to merge. */
export function readRawConfigIfExists(): Record<string, unknown> | undefined {
  const p = configPath();
  if (!fs.existsSync(p)) return undefined;
  try {
    const raw = parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the slim user config as a FULL rewrite (drops comments; used by `doctor --migrate-config`). */
export function saveConfig(cfg: UserConfig): void {
  writeConfigFile(stringify(cfg));
}

/**
 * Persist a set of section updates while PRESERVING the rest of the file — comments,
 * key order, and hand-edited sections outside the patched paths survive. This is the
 * yaml-package Document API doing properly what hermes-desktop attempted with regex
 * patches. Used by setup: it only claims the sections the wizard actually asked about,
 * and by the `/setting` chat command, which writes one scalar at a time.
 *
 * A patch whose `value` is `undefined` DELETES that key rather than writing it. That
 * distinction is load-bearing for optional fields: `agents[].model` is
 * `z.string().optional()`, and serializing "no model" as `null` would make the very next
 * `loadConfig` fail validation — i.e. a write that bricks the file it was clearing.
 * Deleting a path that does not exist is a no-op.
 *
 * A path segment may be a number, addressing one entry of a sequence (`['agents', 1, 'model']`).
 * The INDEX must be resolved against this file, not against a runtime array — see
 * daemon/settings-store.ts for why.
 */
export function saveConfigPatch(patch: Array<{ path: Array<string | number>; value: unknown }>): void {
  const p = configPath();
  // parseDocument('') yields an empty document; setIn creates block-style collections as needed.
  const doc = parseDocument(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  for (const { path: at, value } of patch) {
    if (value === undefined) doc.deleteIn(at);
    else doc.setIn(at, doc.createNode(value));
  }
  writeConfigFile(doc.toString());
}

function writeConfigFile(text: string): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const p = configPath();
  fs.writeFileSync(p, text, { mode: 0o600 });
  fs.chmodSync(p, 0o600); // writeFileSync's mode is ignored for an existing file; tighten explicitly.
}

export function resolveSocketPath(cfg: Config): string {
  // socketPath accepts a user-written path; expand the leading `~` (consistent with agents[].cwd).
  return cfg.ipc.socketPath ? expandHome(cfg.ipc.socketPath) : defaultSocketPath();
}
