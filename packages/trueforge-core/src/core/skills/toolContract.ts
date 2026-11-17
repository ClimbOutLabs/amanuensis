/**
 * Canonical owner of the skill tool names. Adding or removing a skill always asks first; reading the list runs
 * without a card. Nothing here changes a skill that stays.
 */
export const SKILL_SERVER_ID = 'skills';

export const LIST_SKILLS_TOOL_NAME = 'list_skills';
export const INSTALL_SKILL_TOOL_NAME = 'install_skill';
export const REMOVE_SKILL_TOOL_NAME = 'remove_skill';

/** Calls that save a new skill and so show an approval card first. */
export function isSkillWriteToolName(tool_name: string): boolean {
  return tool_name === INSTALL_SKILL_TOOL_NAME;
}

/** Calls that take a skill away, with its websites, and so show an approval card first. */
export function isSkillRemoveToolName(tool_name: string): boolean {
  return tool_name === REMOVE_SKILL_TOOL_NAME;
}
