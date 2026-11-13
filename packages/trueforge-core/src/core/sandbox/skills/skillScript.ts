import { shellEscape } from '../provider/Provider';
import { getSkillPath } from './constants';

/** The program that runs a skill script, chosen by the script's file type. The model never names it. */
const RUNTIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.py', 'python3'],
  ['.js', 'node'],
  ['.mjs', 'node'],
  ['.cjs', 'node'],
]);

/** A relative path of plain name parts. No `/` at the start, no `~`, no `.` or `..` parts, no shell characters. */
const SCRIPT_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

export interface SkillScriptOk {
  status: 'ok';
  skill_folder: string;
  /** The script's full path, which must still resolve inside `skill_folder` when it runs. */
  script_path: string;
  /** The program, the script and its arguments, run as given with no shell. */
  argv: readonly string[];
  /** A readable copy of `argv` for the activity list and the result. */
  command: string;
}

export type SkillScriptRun = SkillScriptOk | { status: 'invalid'; message: string };

/**
 * The command that runs one script shipped inside a skill turned on in this chat, from that skill's folder.
 * The program comes from the file type and every part is a separate argument, so nothing the model sends is
 * read as shell syntax.
 */
export function skillScriptRun(input: {
  skillsDir: string;
  skillNames: readonly string[];
  skill: string;
  script: string;
  args: readonly string[];
}): SkillScriptRun {
  if (!input.skillNames.includes(input.skill)) {
    const available = input.skillNames.length === 0 ? 'none' : input.skillNames.join(', ');
    return {
      status: 'invalid',
      message: `No skill named '${input.skill}' is turned on in this chat. Use one of these skill names: ${available}.`,
    };
  }
  const parts = input.script.split('/');
  if (parts.some(part => !SCRIPT_PART.test(part))) {
    return {
      status: 'invalid',
      message: `'${input.script}' is not a path inside the skill's folder. Give the script's path from the skill's folder, such as scripts/run.py.`,
    };
  }
  const dot = input.script.lastIndexOf('.');
  const runtime = dot === -1 ? undefined : RUNTIME_BY_EXTENSION.get(input.script.slice(dot).toLowerCase());
  if (runtime === undefined) {
    return {
      status: 'invalid',
      message: `'${input.script}' is not a Python or JavaScript file. Only .py, .js, .mjs and .cjs scripts can run this way.`,
    };
  }
  const skillFolder = getSkillPath({ skillsDir: input.skillsDir, skillName: input.skill });
  const argv = [runtime, input.script, ...input.args];
  return {
    status: 'ok',
    skill_folder: skillFolder,
    script_path: `${skillFolder}/${input.script}`,
    argv,
    command: argv.map(shellEscape).join(' '),
  };
}

/** The `realpath -e` operands whose output `skillScriptStaysInFolder` reads: the skills folder, the skill, the script. */
export function skillScriptRealPathOperands(input: { skillsDir: string; run: SkillScriptOk }): string[] {
  return [input.skillsDir, input.run.skill_folder, input.run.script_path];
}

/**
 * Whether the script, read through any links, is still inside the skill's folder, and neither that folder nor
 * the skills folder is a link to somewhere else. `resolved` is what `realpath -e` printed for
 * `skillScriptRealPathOperands`, one path per line. Anything else, such as a missing file, fails.
 */
export function skillScriptStaysInFolder(input: { skillsDir: string; skill: string; resolved: string }): boolean {
  const lines = input.resolved.split('\n').filter(line => line !== '');
  const [skillsReal, folderReal, scriptReal] = lines;
  if (lines.length !== 3 || skillsReal === undefined || folderReal === undefined || scriptReal === undefined) {
    return false;
  }
  // A relative skills folder (a provider whose layout is relative to its own root) is judged by the real paths.
  const skillsInPlace = !input.skillsDir.startsWith('/') || skillsReal === input.skillsDir.replace(/\/+$/u, '');
  return skillsInPlace && folderReal === `${skillsReal}/${input.skill}` && scriptReal.startsWith(`${folderReal}/`);
}
