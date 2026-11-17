import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import { createHash } from 'node:crypto';

/** Persona ids are derived from the owner's id, so they are unique per tenant and stay the same across upgrades. */
function guideIdFor(prefix: string, userId: string): string {
  return `${prefix}-${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

/** Each person's guide id, so chats with the guide keep working across upgrades. */
export function amanGuidePersonaId(userId: string): string {
  return guideIdFor('iris', userId);
}

/** The id the guide had before the rename to Iris. Exports written then still carry it. */
export function legacyAmanGuidePersonaId(userId: string): string {
  return guideIdFor('aman-guide', userId);
}

/** True only for the guide the person owns, under either id. The ids are derived, so a persona they named cannot match. */
export function isAmanGuidePersona(persona: { id: string; created_by: string }): boolean {
  return (
    persona.id === amanGuidePersonaId(persona.created_by) || persona.id === legacyAmanGuidePersonaId(persona.created_by)
  );
}

/** True for a guide id of any owner and any version, as an archive names it. */
export function isAnyAmanGuideId(id: string): boolean {
  return /^(iris|aman-guide)-[0-9a-f]{16}$/.test(id);
}

/**
 * Opens the source label of every knowledge document the guide installer writes: her name and the
 * word "build", with a hash of the page after it. The label is stored bookkeeping that lets a
 * refresh replace only her pages. It is never shown to a person.
 */
export const AMAN_GUIDE_SOURCE_LABEL_PREFIX = `${AMAN_GUIDE_NAME}, build `;

/** True for a knowledge document the guide installer wrote, told by the label stored on it. */
export function isAmanGuideSourceLabel(sourceLabel: string): boolean {
  return sourceLabel.startsWith(AMAN_GUIDE_SOURCE_LABEL_PREFIX);
}
