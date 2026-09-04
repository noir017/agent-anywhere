import { afterEach, describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { configDir, configPath, defaultSocketPath } from './load.js';

/**
 * configPath/configDir resolution precedence: AGENT_ANYWHERE_CONFIG_FILE (the `--config` flag, plumbed
 * through process.env so the spawned agent's reverse commands resolve the same file) overrides
 * AGENT_ANYWHERE_CONFIG_DIR, which overrides the ~/.config/agent-anywhere default.
 */
describe('config path resolution', () => {
  const saved = {
    file: process.env.AGENT_ANYWHERE_CONFIG_FILE,
    dir: process.env.AGENT_ANYWHERE_CONFIG_DIR,
  };
  afterEach(() => {
    if (saved.file === undefined) delete process.env.AGENT_ANYWHERE_CONFIG_FILE;
    else process.env.AGENT_ANYWHERE_CONFIG_FILE = saved.file;
    if (saved.dir === undefined) delete process.env.AGENT_ANYWHERE_CONFIG_DIR;
    else process.env.AGENT_ANYWHERE_CONFIG_DIR = saved.dir;
  });

  it('defaults to ~/.config/agent-anywhere/config.yaml', () => {
    delete process.env.AGENT_ANYWHERE_CONFIG_FILE;
    delete process.env.AGENT_ANYWHERE_CONFIG_DIR;
    expect(configPath()).toBe(path.join(os.homedir(), '.config', 'agent-anywhere', 'config.yaml'));
  });

  // The precedence rules are platform-independent, but the paths they produce are not: configPath
  // joins/resolves with the host separator, and on Windows path.resolve('/etc/x') also gains the
  // current drive letter. So the expectations are built with the same primitives the implementation
  // uses — asserting literal POSIX strings only tested that the suite was running on POSIX.
  it('honors AGENT_ANYWHERE_CONFIG_DIR', () => {
    delete process.env.AGENT_ANYWHERE_CONFIG_FILE;
    process.env.AGENT_ANYWHERE_CONFIG_DIR = '/srv/am';
    expect(configPath()).toBe(path.join('/srv/am', 'config.yaml'));
    expect(defaultSocketPath()).toBe(path.join('/srv/am', 'daemon.sock'));
  });

  it('AGENT_ANYWHERE_CONFIG_FILE points configPath at the file and configDir at its parent', () => {
    process.env.AGENT_ANYWHERE_CONFIG_DIR = '/srv/am'; // must be ignored when FILE is set
    process.env.AGENT_ANYWHERE_CONFIG_FILE = '/etc/agent-anywhere/discord.yaml';
    const resolved = path.resolve('/etc/agent-anywhere/discord.yaml');
    expect(configPath()).toBe(resolved);
    expect(configDir()).toBe(path.dirname(resolved));
    // socket sits next to the chosen file (one daemon at a time, so no collision with other configs).
    expect(defaultSocketPath()).toBe(path.join(path.dirname(resolved), 'daemon.sock'));
  });

  it('expands a leading ~ in AGENT_ANYWHERE_CONFIG_FILE', () => {
    process.env.AGENT_ANYWHERE_CONFIG_FILE = '~/am/discord.yaml';
    expect(configPath()).toBe(path.join(os.homedir(), 'am', 'discord.yaml'));
  });
});
