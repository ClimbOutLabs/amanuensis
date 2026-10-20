import { isPersonaDeterminer, personaMatchKey } from '../personas/persona';
import { PERSONA_NAME_CHARACTER, PERSONA_NAME_MAX_LENGTH, PersonaNameSchema } from '../schemas/persona';
import { isRecord } from './lenient';

export interface PersonaNameRepair {
  /** The personas section with every name and alias made to fit today's rules. */
  json: unknown;
  /** One plain sentence per visible change, for the import summary. */
  lines: string[];
}

const CHARACTERS_REASON = "names can only use letters, numbers, spaces, _ - and '";
const LENGTH_REASON = `names can be at most ${String(PERSONA_NAME_MAX_LENGTH)} characters`;
const START_REASON = 'names must start with a letter or number';
const EMPTY_REASON = 'it has no letters or numbers';
const RESERVED_REASON = '"my", "the", "a" and "an" can\'t be names on their own';
const MARK_REASON = 'it uses characters that names cannot hold now';
const CLASH_REASON = 'another persona already uses that name';
const OWN_NAME_REASON = "it is the same as the persona's own name";
const OWN_ALIAS_REASON = "it is already one of the persona's aliases";

interface CleanedName {
  text: string;
  /** A visible change, for the person to be told. Undefined for a silent change such as Unicode form or spacing. */
  reason: string | undefined;
  /** Set when the name cannot be kept at all, so a name gets a number and an alias is dropped. */
  unusable: string | undefined;
}

interface PersonaCandidate {
  entry: Record<string, unknown>;
  persona: Record<string, unknown>;
  displayName: string;
  aliases: unknown[];
}

/**
 * Makes persona names and aliases from an older version fit today's rules before the strict read.
 * A name that already fits is kept as it is. Anything else is cleaned up, and each visible change is reported.
 */
export function repairPersonaNames(json: unknown): PersonaNameRepair {
  if (!Array.isArray(json)) {
    return { json, lines: [] };
  }
  const entries: unknown[] = json;
  const candidates = entries.map(candidateOf);
  const lines: string[] = [];
  // The index of the persona that uses each match key.
  const taken = new Map<string, number>();
  // Aliases that already fit and claimed their key, as `index:slot`.
  const keptAliases = new Set<string>();

  // Names that already fit claim their keys first, so a repaired name never displaces one.
  candidates.forEach((candidate, index) => {
    if (candidate === undefined || !fitsPersonaName(candidate.displayName)) {
      return;
    }
    const key = personaMatchKey(candidate.displayName);
    if (!taken.has(key)) {
      taken.set(key, index);
    }
  });

  // Aliases that already fit come next, so a name generated for a clash never displaces one. An alias
  // that is its own persona's name is left to the alias pass, which reports it as the persona's own name.
  candidates.forEach((candidate, index) => {
    if (candidate === undefined) {
      return;
    }
    const ownKey = wantedKey(candidate.displayName);
    candidate.aliases.forEach((alias, slot) => {
      if (typeof alias !== 'string' || !fitsPersonaName(alias)) {
        return;
      }
      const key = personaMatchKey(alias);
      if (key === ownKey || taken.has(key)) {
        return;
      }
      taken.set(key, index);
      keptAliases.add(`${String(index)}:${String(slot)}`);
    });
  });

  const finalNames = candidates.map((candidate, index) => {
    if (candidate === undefined) {
      return undefined;
    }
    if (taken.get(personaMatchKey(candidate.displayName)) === index) {
      return candidate.displayName;
    }
    const cleaned = cleanName(candidate.displayName);
    let finalName = cleaned.text;
    let reason = cleaned.reason;
    if (cleaned.unusable !== undefined) {
      finalName = freeNumberedName('Persona', taken);
      reason = cleaned.unusable;
    } else if (taken.has(personaMatchKey(finalName))) {
      finalName = freeClashName(finalName, taken);
      reason = reason === undefined ? CLASH_REASON : `${CLASH_REASON}, and ${reason}`;
    }
    taken.set(personaMatchKey(finalName), index);
    if (reason !== undefined) {
      lines.push(`Renamed the persona "${shown(candidate.displayName)}" to "${shown(finalName)}", because ${reason}.`);
    }
    return finalName;
  });

  const repaired = entries.map((entry, index) => {
    const candidate = candidates[index];
    const finalName = finalNames[index];
    if (candidate === undefined || finalName === undefined) {
      return entry;
    }
    const finalKey = personaMatchKey(finalName);
    // Blank aliases from one persona are reported once, since they all say the same thing.
    let blankReported = false;
    const aliases = candidate.aliases.flatMap((alias, slot) => {
      if (typeof alias !== 'string') {
        // Left as it is, so the strict read refuses the section.
        return [alias];
      }
      if (keptAliases.has(`${String(index)}:${String(slot)}`)) {
        return [alias];
      }
      const drop = (because: string) => {
        lines.push(
          `Dropped the persona alias "${shown(alias)}" of the persona "${shown(finalName)}", because ${because}.`,
        );
        return [];
      };
      const cleaned = fitsPersonaName(alias)
        ? { text: alias, reason: undefined, unusable: undefined }
        : cleanName(alias);
      if (cleaned.unusable !== undefined) {
        if (alias.trim() === '') {
          if (blankReported) {
            return [];
          }
          blankReported = true;
        }
        return drop(cleaned.unusable);
      }
      const key = personaMatchKey(cleaned.text);
      const owner = taken.get(key);
      if (owner !== undefined) {
        if (owner !== index) {
          return drop(CLASH_REASON);
        }
        return drop(key === finalKey ? OWN_NAME_REASON : OWN_ALIAS_REASON);
      }
      taken.set(key, index);
      if (cleaned.reason !== undefined) {
        lines.push(
          `Renamed the persona alias "${shown(alias)}" of the persona "${shown(finalName)}" to "${shown(cleaned.text)}", because ${cleaned.reason}.`,
        );
      }
      return [cleaned.text];
    });
    return { ...candidate.entry, persona: { ...candidate.persona, display_name: finalName, aliases } };
  });
  return { json: repaired, lines };
}

function candidateOf(entry: unknown): PersonaCandidate | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const persona = entry['persona'];
  if (!isRecord(persona) || typeof persona['display_name'] !== 'string' || !Array.isArray(persona['aliases'])) {
    return undefined;
  }
  const aliases: unknown[] = persona['aliases'];
  return { entry, persona, displayName: persona['display_name'], aliases };
}

/** A value as it is shown in a line: whitespace and control characters become spaces. */
function shown(value: string): string {
  return value.replace(/[\s\p{Cc}]/gu, ' ');
}

/** Whether a name is accepted as it is, by the same schema and reserved-word check a new name gets. */
function fitsPersonaName(value: string): boolean {
  return PersonaNameSchema.safeParse(value).success && !isPersonaDeterminer(personaMatchKey(value));
}

/** The match key a name is wanted under: its own text when it fits, or its cleaned text when it can be kept. */
function wantedKey(name: string): string | undefined {
  if (fitsPersonaName(name)) {
    return personaMatchKey(name);
  }
  const cleaned = cleanName(name);
  return cleaned.unusable === undefined ? personaMatchKey(cleaned.text) : undefined;
}

/**
 * Cleans a name in the order the rules apply: the Unicode form is made composed, marks that belong to
 * no letter are removed, whitespace and other characters become spaces, spaces collapse, the ends are
 * trimmed, the name is cut to length, and leading characters that are not a letter or number are dropped.
 * Only a visible change gives a reason.
 */
function cleanName(raw: string): CleanedName {
  const { kept, removedMark } = dropMarksOffLetters(raw.normalize('NFC'));
  // In some scripts a combining mark is part of its letter, so removing it would change the word.
  if (/\p{M}/u.test(kept)) {
    return { text: '', reason: MARK_REASON, unusable: MARK_REASON };
  }
  const charactersChanged = Array.from(kept).some(
    character => !/\s/u.test(character) && !PERSONA_NAME_CHARACTER.test(character),
  );
  const spaced = Array.from(kept, character =>
    /\s/u.test(character) || !PERSONA_NAME_CHARACTER.test(character) ? ' ' : character,
  )
    .join('')
    .replace(/ +/g, ' ')
    .trim();
  const cut = truncate(spaced, PERSONA_NAME_MAX_LENGTH);
  const text = cut.replace(/^[^\p{L}\p{N}]+/u, '');
  let reason: string | undefined;
  if (charactersChanged || removedMark) {
    reason = CHARACTERS_REASON;
  } else if (characterCount(spaced) > PERSONA_NAME_MAX_LENGTH) {
    reason = LENGTH_REASON;
  } else if (text !== cut) {
    reason = START_REASON;
  }
  if (text === '') {
    return { text, reason, unusable: EMPTY_REASON };
  }
  if (isPersonaDeterminer(personaMatchKey(text))) {
    return { text, reason, unusable: RESERVED_REASON };
  }
  return { text, reason, unusable: undefined };
}

/**
 * Drops a combining mark that follows no letter, such as a variation selector after an emoji, and keeps
 * the marks that belong to a letter. The base is the last character that is not a mark.
 */
function dropMarksOffLetters(value: string): { kept: string; removedMark: boolean } {
  let kept = '';
  let removedMark = false;
  let base = '';
  for (const character of value) {
    if (!/\p{M}/u.test(character)) {
      base = character;
      kept += character;
    } else if (/\p{L}/u.test(base)) {
      kept += character;
    } else {
      removedMark = true;
    }
  }
  return { kept, removedMark };
}

/** Counted in code points, as the name schema's length check counts them. */
function characterCount(value: string): number {
  return Array.from(value).length;
}

/** The longest prefix of `max` characters; it never splits a character that takes two UTF-16 units. */
function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('').trimEnd();
}

/** "Persona 1", "Persona 2", ... for the first number no persona uses. */
function freeNumberedName(prefix: string, taken: ReadonlyMap<string, number>): string {
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix} ${String(number)}`;
    if (!taken.has(personaMatchKey(candidate))) {
      return candidate;
    }
  }
}

/** "Dr Kim 2", "Dr Kim 3", ... with the base cut so the number still fits the length. */
function freeClashName(base: string, taken: ReadonlyMap<string, number>): string {
  for (let number = 2; ; number += 1) {
    const suffix = ` ${String(number)}`;
    const candidate = `${truncate(base, PERSONA_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(personaMatchKey(candidate))) {
      return candidate;
    }
  }
}
