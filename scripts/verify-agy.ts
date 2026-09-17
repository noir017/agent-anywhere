/**
 * Manual end-to-end check against the real agy on this machine. Not part of the suite.
 *   npx tsx scripts/verify-agy.ts
 */
import { homedir } from 'node:os';
import { installStatusLine, readAgyUsage, agyUsageDir } from '../src/daemon/agy-statusline.js';
import { skillDirsFor, scanSkillDirs } from '../src/daemon/skills-scan.js';
import { runAgyCliCommand, formatAgyCliOutput, buildAgyArgs } from '../src/daemon/agent-agy.js';
import { AgentDefSchema } from '../src/config/schema.js';

const def = AgentDefSchema.parse({ id: 'agy', harness: 'agy' });
const home = homedir();

console.log('1. statusline install:', installStatusLine(home), '→', agyUsageDir());

const dirs = skillDirsFor(def, { home, cwd: '/home/user/workspace/agent-anywhere' });
const skills = await scanSkillDirs(dirs);
console.log('2. skill dirs:', dirs);
console.log('   found', skills.length, 'skills, first five:', skills.slice(0, 5).map((s) => s.name));

for (const name of ['usage', 'credits', 'effort']) {
  const r = await runAgyCliCommand(name, home);
  console.log(`3. /${name} →`, r.ok ? formatAgyCliOutput(name, r.output).split('\n').slice(0, 3) : r);
}

console.log('4. launch args:', buildAgyArgs(def, '/tmp'));
console.log('5. usage recorded for', process.argv[2], '→', readAgyUsage(process.argv[2]));
