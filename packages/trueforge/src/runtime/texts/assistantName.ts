import type { IPersonalizationStore } from '../../db/personalizationStore';
import { assistantNameFor, UNNAMED_ASSISTANT } from '../chatAssistant';
import { isPlainWords, plainText } from './textWords';

/** The most of the assistant's name a text carries, so a name cannot hold a message of its own. */
const TEXT_NAME_MAX = 20;

/** Cuts at the last whole word that fits, or after 20 characters when one word is longer. The cut name is checked again. */
function cutAtWord(text: string): string {
  if (text.length <= TEXT_NAME_MAX) {
    return text;
  }
  const head = text.slice(0, TEXT_NAME_MAX);
  const space = head.lastIndexOf(' ');
  return (text[TEXT_NAME_MAX] === ' ' || space < 0 ? head : head.slice(0, space)).trim();
}

/**
 * The name the person gave their assistant, made fit for the first words of a text: only letters, spaces,
 * apostrophes and dashes inside words, at most 20 of them, so it cannot carry a link or a number to call. The name
 * is checked as given and again as it will be sent, since leaving out signs and cutting it can make new words.
 */
export function textName(name: string | null | undefined): string {
  const plain = plainText(name ?? '');
  const letters = cutAtWord(
    plain
      .replace(/[^A-Za-z '-]/g, ' ')
      .replace(/(?<![A-Za-z])['-]+|['-]+(?![A-Za-z])/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return letters !== '' && isPlainWords(plain) && isPlainWords(letters) ? letters : UNNAMED_ASSISTANT;
}

/** The person's assistant name, as their settings give it, made fit for a text. */
export async function textAssistantName({
  personalization,
  owner,
}: {
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  owner: { tenant_id: string; created_by: string };
}): Promise<string> {
  return textName(await assistantNameFor({ personalizationStore: personalization, owner }));
}
