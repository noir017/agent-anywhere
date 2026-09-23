/**
 * Manual end-to-end check against the real agy on this machine. Not part of the suite.
 *   npx tsx scripts/verify-agy.ts
 *
 * Step 1 rewrites the status-line shim in the config dir and points agy's settings at it. On a
 * machine whose daemon runs a different version, isolate both first — the daemon's own shim is the
 * one being replaced otherwise:
 *   HOME=<scratch home holding a copy of antigravity-oauth-token> \
 *   AGENT_ANYWHERE_CONFIG_DIR=$(mktemp -d) npx tsx scripts/verify-agy.ts
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { AGY_STATUS_FD, AGY_STATUS_FD_ENV, installStatusLine, parseAgyStatusFrame } from '../src/daemon/agy-statusline.js';
import { skillDirsFor, scanSkillDirs } from '../src/daemon/skills-scan.js';
import { runAgyCliCommand, formatAgyCliOutput, buildAgyArgs } from '../src/daemon/agent-agy.js';
import { AgentDefSchema } from '../src/config/schema.js';

const def = AgentDefSchema.parse({ id: 'agy', harness: 'agy' });
const home = homedir();

console.log('1. statusline install:', installStatusLine(home));

const dirs = skillDirsFor(def, { home, cwd: '/home/user/workspace/agent-anywhere' });
const skills = await scanSkillDirs(dirs);
console.log('2. skill dirs:', dirs);
console.log('   found', skills.length, 'skills, first five:', skills.slice(0, 5).map((s) => s.name));

for (const name of ['usage', 'credits', 'effort']) {
  const r = await runAgyCliCommand(name, home);
  console.log(`3. /${name} →`, r.ok ? formatAgyCliOutput(name, r.output).split('\n').slice(0, 3) : r);
}

console.log('4. launch args:', buildAgyArgs(def, '/tmp'));

// The one undocumented thing the footer rests on: agy passing the daemon's fd 3 on to its status
// line command. The status line ticks from startup, so no prompt is sent and nothing is spent.
const frames = await new Promise<string[]>((resolve) => {
  const child = spawn('agy', buildAgyArgs(def, '/tmp'), {
    cwd: '/tmp',
    env: { ...process.env, [AGY_STATUS_FD_ENV]: String(AGY_STATUS_FD) },
    stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
  });
  const pipe = child.stdio[AGY_STATUS_FD];
  const lines: string[] = [];
  if (pipe instanceof Readable) {
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)));
  }
  setTimeout(() => {
    child.kill('SIGINT');
    resolve(lines);
  }, 15_000);
});
console.log(`5. status frames on fd ${AGY_STATUS_FD} in 15s:`, frames.length, '— last:', frames.map(parseAgyStatusFrame).at(-1));
