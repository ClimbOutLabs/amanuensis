import type { IPersonalizationStore } from '../../db/personalizationStore';
import { UNNAMED_ASSISTANT } from '../chatAssistant';
import { mayCarryContactDetail, plainText } from './textWords';

/** The most of a name a text or a call carries, so a name cannot hold a message of its own. */
const NAME_MAX = 20;

/**
 * A name from the person's settings, made fit to say or send: only letters, spaces, and apostrophes and dashes between
 * letters, at most 20 of them, so it cannot carry a link or a number to call. Undefined when nothing of it is left.
 */
export function plainName(name: string | null | undefined): string | undefined {
  const plain = plainText(name ?? '');
  // A name that is not plain words, such as one that holds a number, a site or an address, is not used at all.
  if (mayCarryContactDetail(plain)) {
    return undefined;
  }
  const letters = plain
    .replace(/[^A-Za-z '-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    // After the cut, which can leave a dash at the end: a voice will not say a lone dash or apostrophe as written.
    .replace(/(?<![A-Za-z])['-]|['-](?![A-Za-z])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return letters === '' ? undefined : letters;
}

/** The name the person gave their assistant, made fit for the first words of a text. */
export function textName(name: string | null | undefined): string {
  return plainName(name) ?? UNNAMED_ASSISTANT;
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
