const TURN_USER_PREFIX = 'User: ';
const TURN_ASSISTANT_SEPARATOR = '\n\nAssistant: ';

/** Enthusiasm idioms that use "can't" without stating an inability. */
const IDIOM_PATTERN = /\bcan't wait\b|\bcan't thank\b|\bcan't help but\b/g;

/** Contractions expanded so one marker set covers every spelling. */
const CONTRACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\bi'm\b/g, 'i am'],
  [/\bi'll\b/g, 'i will'],
  [/\bi'd\b/g, 'i would'],
  [/\bcan't\b/g, 'cannot'],
  [/\bcouldn't\b/g, 'could not'],
  [/\bwasn't\b/g, 'was not'],
  [/\bweren't\b/g, 'were not'],
  [/\bisn't\b/g, 'is not'],
  [/\baren't\b/g, 'are not'],
  [/\bdon't\b/g, 'do not'],
  [/\bdoesn't\b/g, 'does not'],
  [/\bdidn't\b/g, 'did not'],
  [/\bwon't\b/g, 'will not'],
  [/\bhaven't\b/g, 'have not'],
  [/\bhasn't\b/g, 'has not'],
];

const ABILITY_SUBJECT = '(?:i|aman|the assistant|assistant)';
const GAP_WORD =
  '(?:am|is|are|was|were|has|have|had|do|does|not|will|would|might|may|be|been|going to|currently|still)';
const ABILITY_MARKER =
  '(?:cannot|could not|unable to|not (?:be |been )?able to|incapable|(?:not|no|lack|lacks) (?:have )?(?:access|permission)|(?:not|no) have the ability|failed to|having trouble)';
const ABILITY_CLAUSE = new RegExp(`\\b${ABILITY_SUBJECT}\\b(?:\\s+${GAP_WORD})*\\s*${ABILITY_MARKER}\\b`);
const ABILITY_FRAGMENT = /^(?:unable to|not able to|could not|will not be able to)\b/;

/** Speech verbs that put a following first-person clause in another speaker's mouth. */
const REPORTING_VERB =
  /\b(?:said|says|told|asked|mentioned|noted|reported|explained|wrote|replied|thinks|thought|believes|believed|confirmed|warned)\b/;
const AMAN_SUBJECT_AT_START = /^(?:i|aman|the assistant|assistant)\b/;

/** Lowercases and canonicalizes a statement so the patterns above see one spelling. */
function normalizeForMatching(statement: string): string {
  let text = statement.replace(/[’‘]/g, "'").trim().toLowerCase();
  text = text.replace(IDIOM_PATTERN, 'canwait');
  for (const [pattern, replacement] of CONTRACTIONS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/\bcan not\b/g, 'cannot');
}

function isAssistantAbilityNote(statement: string): boolean {
  const text = normalizeForMatching(statement);
  const start = text.replace(/^[^a-z]+/, '');
  if (ABILITY_FRAGMENT.test(start)) {
    return true;
  }
  const match = ABILITY_CLAUSE.exec(text);
  if (match === null) {
    return false;
  }
  // A clause another speaker reports ("Alex said I cannot ...") states that
  // speaker's fact, not Aman's note. A reporting clause whose own subject is
  // Aman ("Aman said I cannot ...") still counts as Aman's note.
  const before = text
    .slice(0, match.index)
    .replace(/^[^a-z]+/, '')
    .trim();
  if (before !== '' && !AMAN_SUBJECT_AT_START.test(before) && REPORTING_VERB.test(before)) {
    return false;
  }
  return true;
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
  if (kept.length === sentences.length) {
    return line;
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
  return keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The facts left after dropping ability notes about the assistant; a fact that was only a note is removed. */
export function withoutAbilityNotes(facts: readonly string[]): string[] {
  return facts.map(filterAssistantText).filter(fact => fact !== '');
}

/** Removes the assistant's ability notes from assistant turn text; all other content is returned unchanged. */
export function stripAssistantAbilityNotes(content: string): string {
  if (content.startsWith(TURN_USER_PREFIX)) {
    const separatorAt = content.indexOf(TURN_ASSISTANT_SEPARATOR);
    if (separatorAt < 0) {
      return content;
    }
    const personText = content.slice(TURN_USER_PREFIX.length, separatorAt);
    const assistantText = content.slice(separatorAt + TURN_ASSISTANT_SEPARATOR.length);
    const keptAssistant = filterAssistantText(assistantText);
    if (keptAssistant === '') {
      return personText.trim() === '' ? '' : `${TURN_USER_PREFIX}${personText}`;
    }
    return `${TURN_USER_PREFIX}${personText}${TURN_ASSISTANT_SEPARATOR}${keptAssistant}`;
  }
  return content;
}
