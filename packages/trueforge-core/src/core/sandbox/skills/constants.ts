// Skill prompt constants and helpers: how skills are described to the agent in the system prompt.
import { z } from '@hono/zod-openapi';

/**
 * How the <skills> prompt section presents mounted skills. `advertise` lists
 * name/description/path and the model reads SKILL.md itself; `inline` embeds
 * preloaded SKILL.md content so the model skips that read hop.
 */
export const SkillPromptModeSchema = z
  .enum(['advertise', 'inline'])
  .describe("How mounted skills are presented in the prompt. Default: 'advertise'.");

export type SkillPromptMode = z.infer<typeof SkillPromptModeSchema>;

// On-disk directory a skill is materialized into, keyed by its (unique) name.
export function getSkillPath(params: { skillsDir: string; skillName: string }): string {
  return `${params.skillsDir.replace(/\/+$/, '')}/${params.skillName}`;
}

export const SKILLS_PREAMBLE = [
  '1. The skill is present in the `path` directory.',
  '2. SKILL.md file within the directory is the primary file, there can be other files as well.',
  '3. Use `description` (and `when_to_use` triggers when present) to judge whether the Agent needs to use a skill.',
  "4. Precedence: when a skill's `description` or `when_to_use` triggers match the current task, the Agent MUST use that skill and MUST NOT substitute generic exec/file/MCP/web tools for what the skill provides. A skill takes precedence over ad-hoc tool use for its advertised purpose.",
  '5. To use a skill:',
  '5.a. If the `SKILL.md content` is inlined, the Agent must not read `path/SKILL.md`.',
  '5.b. Otherwise the Agent must read `path/SKILL.md` first.',
  '6. The Agent must avoid listing the `path` unless there are references in `SKILL.md` and there is reason to do so given the current conversation.',
].join('\n');

// The <skill> block body: inline preloaded SKILL.md when present, else advertise path/name/description.
export function renderSkillPromptBody(params: {
  path: string;
  name: string;
  description: string;
  when_to_use?: readonly string[] | undefined;
  preloadContent: string | null;
}): string {
  const header = `path: ${params.path}\nname: ${params.name}\ndescription: ${params.description}`;
  const whenToUse =
    params.when_to_use !== undefined && params.when_to_use.length > 0
      ? `\nwhen_to_use:\n${params.when_to_use.map(trigger => `- ${trigger}`).join('\n')}`
      : '';
  return params.preloadContent
    ? `${header}${whenToUse}\nSKILL.md content:\n${params.preloadContent}`
    : `${header}${whenToUse}`;
}
