import { isPersonaDeterminer, personaMatchKey } from '../personas/persona';
import { PERSONA_NAME_MAX_LENGTH, PersonaNameSchema } from '../schemas/persona';
import { isRecord } from './lenient';

export interface PersonaNameRepair {
  /** The personas section with every name and alias made to fit today's rules. */
  json: unknown;
  /** One plain sentence per change, for the import summary. */
  lines: string[];
}

const CHARACTERS_REASON = "names can only use letters, numbers, spaces, _ - and '";
const LENGTH_REASON = `names can be at most ${String(PERSONA_NAME_MAX_LENGTH)} characters`;
const START_REASON = 'names must start with a letter or number';
const EMPTY_REASON = 'it has no letters or numbers';
const RESERVED_REASON = 'it is a reserved word';
const CLASH_REASON = 'another persona already uses that name';
const OWN_NAME_REASON = "it is the same as the persona's own name";
const OWN_ALIAS_REASON = "it is already one of the persona's aliases";

interface PersonaCandidate {
  entry: Record<string, unknown>;
  persona: Record<string, unknown>;
  displayName: string;
  aliases: unknown[];
}

/**
 * Makes persona names and aliases from an older version fit today's rules before the strict read.
 * A name that already fits is kept as it is. Anything else is cleaned up, and each change is reported.
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
    if (finalName === '') {
      finalName = freeNumberedName('Persona', taken);
      reason = EMPTY_REASON;
    } else if (isPersonaDeterminer(personaMatchKey(finalName))) {
      finalName = freeNumberedName('Persona', taken);
      reason = RESERVED_REASON;
    } else if (taken.has(personaMatchKey(finalName))) {
      finalName = freeClashName(finalName, taken);
      reason = reason === undefined ? CLASH_REASON : `${CLASH_REASON}, and ${reason}`;
    }
    taken.set(personaMatchKey(finalName), index);
    if (finalName !== candidate.displayName) {
      lines.push(
        `Renamed the persona "${candidate.displayName}" to "${finalName}", because ${reason ?? CLASH_REASON}.`,
      );
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
    const aliases = candidate.aliases.flatMap(alias => {
      if (typeof alias !== 'string') {
        // Left as it is, so the strict read refuses the section.
        return [alias];
      }
      const cleaned = fitsPersonaName(alias) ? { text: alias, reason: undefined } : cleanName(alias);
      const key = personaMatchKey(cleaned.text);
      const drop = (because: string) => {
        lines.push(`Dropped the persona alias "${alias}" of the persona "${finalName}", because ${because}.`);
        return [];
      };
      if (cleaned.text === '') {
        return drop(EMPTY_REASON);
      }
      if (isPersonaDeterminer(key)) {
        return drop(RESERVED_REASON);
      }
      const owner = taken.get(key);
      if (owner !== undefined) {
        if (owner !== index) {
          return drop(CLASH_REASON);
        }
        return drop(key === finalKey ? OWN_NAME_REASON : OWN_ALIAS_REASON);
      }
      taken.set(key, index);
      if (cleaned.text !== alias && cleaned.reason !== undefined) {
        lines.push(
          `Renamed the persona alias "${alias}" of the persona "${finalName}" to "${cleaned.text}", because ${cleaned.reason}.`,
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

/** Whether a name is accepted as it is, by the same schema and reserved-word check a new name gets. */
function fitsPersonaName(value: string): boolean {
  return PersonaNameSchema.safeParse(value).success && !isPersonaDeterminer(personaMatchKey(value));
}

/**
 * Cleans a name in the order the rules apply: other characters become spaces, spaces collapse,
 * the ends are trimmed, the name is cut to length, and leading characters that are not a letter or
 * number are dropped. The reason is for the first change that applies; none when nothing changed.
 */
function cleanName(raw: string): { text: string; reason: string | undefined } {
  const normalized = raw.normalize('NFC');
  const spaced = normalized
    .replace(/[^\p{L}\p{N} _'-]/gu, ' ')
    .replace(/ +/g, ' ')
    .trim();
  const cut = truncate(spaced, PERSONA_NAME_MAX_LENGTH);
  const text = cut.replace(/^[^\p{L}\p{N}]+/u, '');
  if (text === raw) {
    return { text, reason: undefined };
  }
  if (/[^\p{L}\p{N} _'-]/u.test(normalized)) {
    return { text, reason: CHARACTERS_REASON };
  }
  if (characterCount(raw.trim()) > PERSONA_NAME_MAX_LENGTH) {
    return { text, reason: LENGTH_REASON };
  }
  return { text, reason: cut === text ? LENGTH_REASON : START_REASON };
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
