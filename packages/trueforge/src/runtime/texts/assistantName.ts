import type { IPersonalizationStore } from '../../db/personalizationStore';
import { assistantNameFor, UNNAMED_ASSISTANT } from '../chatAssistant';
import { isPlainWords, plainText } from './textWords';

/** The most of a name a text or a call carries, so a name cannot hold a message of its own. */
const TEXT_NAME_MAX = 20;

/** Cuts at the last whole word, so a cut never makes a new word, such as comet cut to com. */
function cutAtWord(text: string): string {
  if (text.length <= TEXT_NAME_MAX) {
    return text;
  }
  const head = text.slice(0, TEXT_NAME_MAX);
  const space = head.lastIndexOf(' ');
  return (text[TEXT_NAME_MAX] === ' ' || space < 0 ? head : head.slice(0, space)).trim();
}

/** Dashes and apostrophes that are not inside a word, which a voice would not say as written. */
const LONE_MARKS = /(?<![A-Za-z])['-]+|['-]+(?![A-Za-z])/g;

/** Letters that do not split into a base letter and an accent, so stripping accents would drop them. */
const SPELLED_LETTERS: Record<string, string> = {
  ø: 'o',
  Ø: 'O',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  æ: 'ae',
  Æ: 'Ae',
  ß: 'ss',
};

function spellOut(name: string): string {
  return name.replace(/[øØłŁđĐæÆß]/g, letter => SPELLED_LETTERS[letter] ?? letter);
}

/**
 * A name from the person's settings, made fit to say or send: only letters, spaces, apostrophes and dashes inside
 * words, at most 20 of them, so it cannot carry a link or a number to call. The name is checked as given and again as
 * it will be used, since leaving out signs and cutting it can make new words. Undefined when it cannot be used.
 */
export function plainName(name: string | null | undefined): string | undefined {
  const plain = plainText(spellOut(name ?? ''));
  const letters = cutAtWord(
    plain
      .replace(/[^A-Za-z '-]/g, ' ')
      .replace(LONE_MARKS, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    // A cut inside a long word can leave a dash at its end.
    .replace(LONE_MARKS, ' ')
    .trim();
  return letters !== '' && isPlainWords(plain) && isPlainWords(letters) ? letters : undefined;
}

/** The name the person gave their assistant, made fit for the first words of a text. */
export function textName(name: string | null | undefined): string {
  return plainName(name) ?? UNNAMED_ASSISTANT;
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
