import { UNNAMED_ASSISTANT } from '../chatAssistant';
import { textName } from '../texts/assistantName';

/** Letters that do not split into a base letter and an accent, so cleaning would drop them. */
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
  Þ: 'Th',
  þ: 'th',
  Œ: 'Oe',
  œ: 'oe',
  Ħ: 'H',
  ħ: 'h',
  Ð: 'D',
  ð: 'd',
};

/**
 * A name a call may say, by the same rule as a text (`textName`, the one owner), after spelling out the letters that
 * cleaning would drop. Undefined when no usable name is left, so the call leaves the name out.
 */
export function callName(name: string | null | undefined): string | undefined {
  const spelled = (name ?? '').replace(/[øØłŁđĐæÆßÞþŒœĦħÐð]/g, letter => SPELLED_LETTERS[letter] ?? letter);
  const fit = textName(spelled);
  return fit === UNNAMED_ASSISTANT ? undefined : fit;
}
