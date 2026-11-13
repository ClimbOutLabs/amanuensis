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

export type SkillScriptRun =
  { status: 'ok'; skill_folder: string; command: string } | { status: 'invalid'; message: string };

/**
 * The command that runs one script shipped inside a skill turned on in this chat, from that skill's folder.
 * Every part is checked or quoted here, so nothing the model sends is read as shell syntax.
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
  return {
    status: 'ok',
    skill_folder: getSkillPath({ skillsDir: input.skillsDir, skillName: input.skill }),
    command: [runtime, shellEscape(input.script), ...input.args.map(shellEscape)].join(' '),
  };
}
