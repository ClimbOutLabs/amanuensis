import type { IPersonalizationStore } from '../../db/personalizationStore';
import { UNNAMED_ASSISTANT } from '../chatAssistant';
import { plainText } from './textWords';

/** The most of the assistant's name a text carries, so a name cannot hold a message of its own. */
const TEXT_NAME_MAX = 20;

/**
 * The name the person gave their assistant, made fit for the first words of a text: only letters, spaces,
 * apostrophes and dashes, at most 20 of them, so it cannot carry a link or a number to call.
 */
export function textName(name: string | null | undefined): string {
  const letters = plainText(name ?? '')
    .replace(/[^A-Za-z '-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_NAME_MAX)
    .trim();
  return letters === '' ? UNNAMED_ASSISTANT : letters;
}

/** The person's assistant name for a text, from their own settings. */
export async function assistantNameFor({
  personalization,
  owner,
}: {
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  owner: { tenant_id: string; created_by: string };
}): Promise<string> {
  const profile = await personalization.getProfile(owner);
  return textName(profile?.assistant_name);
}
