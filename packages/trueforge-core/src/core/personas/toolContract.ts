/**
 * Canonical owner of the persona tool names. Adding a specialist always asks first; nothing here edits or
 * deletes an existing persona.
 */
export const PERSONA_SERVER_ID = 'personas';

export const CREATE_PERSONA_TOOL_NAME = 'create_persona';

/** Calls that save a new persona and so show an approval card first. */
export function isPersonaWriteToolName(tool_name: string): boolean {
  return tool_name === CREATE_PERSONA_TOOL_NAME;
}
