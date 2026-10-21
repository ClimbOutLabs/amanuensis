import { createHash } from 'node:crypto';

/** The guide's name. Every name the app shows for her comes from this one constant. */
export const IRIS_NAME = 'Iris';
export const IRIS_DESCRIPTION = 'Your guide to Aman. Ask me anything about how Aman works.';

/**
 * Persona ids are unique per tenant, so each person's guide id is derived from their id. It stays
 * the same across upgrades, so chats with the guide keep working.
 */
export function amanGuidePersonaId(userId: string): string {
  return `iris-${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

/** True only for the guide the person owns. The id is derived, so a persona they named cannot match it. */
export function isAmanGuidePersona(persona: { id: string; created_by: string }): boolean {
  return persona.id === amanGuidePersonaId(persona.created_by);
}
