/**
 * Canonical owner of the persona tool names. Adding a persona always asks first; reading the list and
 * switching this chat to an existing persona run without a card. Nothing here edits or deletes a persona.
 */
export const PERSONA_SERVER_ID = 'personas';

export const CREATE_PERSONA_TOOL_NAME = 'create_persona';
export const LIST_PERSONAS_TOOL_NAME = 'list_personas';
export const USE_PERSONA_TOOL_NAME = 'use_persona';

/** Calls that save a new persona and so show an approval card first. */
export function isPersonaWriteToolName(tool_name: string): boolean {
  return tool_name === CREATE_PERSONA_TOOL_NAME;
}
