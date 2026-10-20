/**
 * The one guard on the memory write path: a note about Aman's own abilities is
 * never stored as a memory. When a tool call fails and Aman says "I can't read
 * email", that sentence is about Aman's last attempt, not about the person, yet
 * the turn retain and the profile mirror would otherwise keep it and recall it
 * later as if it were a fact. Both memory backends run every retained item
 * through here before writing, so no producer can save such a note.
 *
 * The filter drops whole statements, never whole memories: the rest of the
 * turn still saves. It only matches statements whose subject is Aman (first
 * person in Aman's own text, "the assistant", "Aman") carrying an inability
 * marker, or a subject-less inability fragment ("Unable to ..."). Facts about
 * the person keep a different subject and pass untouched, including facts about
 * what the person can or cannot do. In a verbatim turn transcript the person's
 * own side is never filtered at all: there, "I" is the person.
 */

const TURN_USER_PREFIX = 'User: ';
const TURN_ASSISTANT_SEPARATOR = '\n\nAssistant: ';
const TURN_SUMMARY_PREFIX = 'Turn summary: ';

/** Enthusiasm idioms that use "can't" without stating an inability. */
const IDIOM_PATTERN = /\bcan't wait\b|\bcan't thank\b|\bcan't help but\b/g;

/** Contractions expanded so one marker set covers every spelling. */
const CONTRACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\bi'm\b/g, 'i am'],
  [/\bcan't\b/g, 'cannot'],
  [/\bcouldn't\b/g, 'could not'],
  [/\bwasn't\b/g, 'was not'],
  [/\bweren't\b/g, 'were not'],
  [/\bisn't\b/g, 'is not'],
  [/\baren't\b/g, 'are not'],
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bdidn't\b/g, 'did not'],
];

const ABILITY_SUBJECT = '(?:i|aman|the assistant|assistant)';
const GAP_WORD = '(?:am|is|are|was|were|has|have|do|does|not|currently|still)';
const ABILITY_MARKER =
  '(?:cannot|could not|unable to|not able to|have (?:access|permission)|no (?:access|permission) to|failed to|having trouble)';
const ABILITY_CLAUSE = new RegExp(`\\b${ABILITY_SUBJECT}\\b(?:\\s+${GAP_WORD})*\\s*${ABILITY_MARKER}\\b`);
const ABILITY_FRAGMENT = /^(?:unable to|not able to|could not|cannot|no (?:access|permission) to)\b/;

/** Lowercases and canonicalizes a statement so the two patterns above see one spelling. */
function normalizeForMatching(statement: string): string {
  let text = statement.replace(/[’‘]/g, "'").trim().toLowerCase();
  text = text.replace(IDIOM_PATTERN, 'canwait');
  for (const [pattern, replacement] of CONTRACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function isAssistantAbilityNote(statement: string): boolean {
  const text = normalizeForMatching(statement);
  const start = text.replace(/^[^a-z]+/, '');
  return ABILITY_FRAGMENT.test(start) || ABILITY_CLAUSE.test(text);
}

/** One line with its ability-note sentences removed; undefined when nothing on the line survives. */
function filterLine(line: string): string | undefined {
  if (line.trim() === '') {
    return line;
  }
  const bullet = /^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/.exec(line);
  const prefix = bullet?.[1] ?? '';
  const body = bullet?.[2] ?? line;
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '');
  const kept = sentences.filter(sentence => !isAssistantAbilityNote(sentence));
  if (kept.length === 0) {
    return undefined;
  }
  return prefix + kept.join(' ');
}

/** Assistant-voiced text with ability-note statements removed; structure and other statements stay. */
function filterAssistantText(text: string): string {
  const keptLines: string[] = [];
  for (const line of text.split('\n')) {
    const kept = filterLine(line);
    if (kept !== undefined) {
      keptLines.push(kept);
    }
  }
  return keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Removes ability notes about Aman from one retained item's content. Returns an
 * empty string when nothing else remains, so the caller drops the item.
 */
export function stripAssistantAbilityNotes(content: string): string {
  if (content.startsWith(TURN_USER_PREFIX)) {
    const separatorAt = content.indexOf(TURN_ASSISTANT_SEPARATOR);
    if (separatorAt >= 0) {
      const personText = content.slice(TURN_USER_PREFIX.length, separatorAt);
      const assistantText = content.slice(separatorAt + TURN_ASSISTANT_SEPARATOR.length);
      const keptAssistant = filterAssistantText(assistantText);
      if (keptAssistant === '') {
        return personText.trim() === '' ? '' : `${TURN_USER_PREFIX}${personText}`;
      }
      return `${TURN_USER_PREFIX}${personText}${TURN_ASSISTANT_SEPARATOR}${keptAssistant}`;
    }
  }
  if (content.startsWith(TURN_SUMMARY_PREFIX)) {
    const kept = filterAssistantText(content.slice(TURN_SUMMARY_PREFIX.length));
    return kept === '' ? '' : `${TURN_SUMMARY_PREFIX}${kept}`;
  }
  return filterAssistantText(content);
}
