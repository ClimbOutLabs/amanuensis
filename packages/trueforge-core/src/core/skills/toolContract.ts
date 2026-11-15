/**
 * Canonical owner of the skill tool names. Adding a skill always asks first; reading the list runs
 * without a card. Nothing here changes or removes a skill.
 */
export const SKILL_SERVER_ID = 'skills';

export const LIST_SKILLS_TOOL_NAME = 'list_skills';
export const INSTALL_SKILL_TOOL_NAME = 'install_skill';

/** Calls that save a new skill and so show an approval card first. */
export function isSkillWriteToolName(tool_name: string): boolean {
  return tool_name === INSTALL_SKILL_TOOL_NAME;
}
