/**
 * What the host lets the model do with a note. The model's decisions are checked against the vault and then held
 * to the note's origin, so a note cannot talk its way into more. The note's text is read for one thing only, and
 * only to take away: a line the model worded with a word found only in what Aman read is not marked as theirs.
 */
import { kindHasSection, type PageKind, type PageListing } from './memoryPages';
import { holdsWordOnlyRead } from './memorySummarize';
import type { SortDecision } from './pageSortDecisions';
import type { NoteOrigin } from './pageSortOrigin';
import { OWN_STATEMENT_SOURCES, type ShownPage, type ShownStatement, type ShownWords } from './pageSortPrompt';
import { cleanLine, MAX_FACT_CHARS, MAX_NAME_CHARS, sameText } from './pageStatements';

/** One decision after the checks and the origin rules, with the page and statement it resolved to. */
export interface PlannedDecision {
  decision: SortDecision;
  /** The kind of the page the decision is about; undefined for `ignore`. */
  kind: PageKind | undefined;
  /** The statement a `same`, `changed` or `ended` decision names, as the prompt showed it. */
  target: ShownStatement | undefined;
  /**
   * True when the line holds a word found only in what Aman read, such as a word from a read line the model was
   * shown. The line is written as Aman's guess, never as the person's.
   */
  guessed: boolean;
}

export type RuledReply = { ok: true; planned: PlannedDecision[] } | { ok: false; reason: string };

const WRITING_SECTION = 'How you write to them';

interface RuleContext {
  origin: NoteOrigin;
  /** The note being sorted. Compared with the model's wording, never obeyed. */
  noteText: string;
  day: string;
  shown: readonly ShownPage[];
  known: readonly PageListing[];
  /** What the prompt showed besides the note, split by whose words it is. */
  words: ShownWords;
}

type Step = { ok: true; planned: PlannedDecision } | { ok: false; reason: string };

function refuse(reason: string): Step {
  return { ok: false, reason };
}

/** The note's day in the words and numbers a line may write it with, such as "September 8 2026 Tuesday". */
function dayInWords(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return day;
  }
  const words = new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
  return `${day} ${words} ${String(date.getUTCMonth() + 1)}`;
}

/**
 * Whether the model's wording may carry the note's own-words mark. The model is shown every line of the pages,
 * whatever its source, so a line it words for the person's own note stays theirs only while none of its words
 * is found solely in what was read: the statements and page names the prompt showed that are not the person's.
 * A word that is also in the note, in a statement of theirs, in a page name of theirs or in the note's day is theirs.
 */
function wordedInOwnWords({ text, context }: { text: string; context: RuleContext }): boolean {
  return (
    context.origin.kind !== 'own_words' ||
    !holdsWordOnlyRead({
      text,
      ownText: [context.noteText, ...context.words.own, dayInWords(context.day)].join('\n'),
      readText: context.words.read.join('\n'),
    })
  );
}

function plain({ raw, what, limit }: { raw: string; what: string; limit: number }): string | undefined {
  const line = cleanLine({ raw, what, limit });
  return line.ok ? line.text : undefined;
}

/** The shown page of this slug that holds a statement with this id. */
function shownTarget({
  shown,
  about,
  id,
}: {
  shown: readonly ShownPage[];
  about: string;
  id: string;
}): { page: ShownPage; statement: ShownStatement } | undefined {
  for (const page of shown) {
    const statement = page.slug === about ? page.statements.find(candidate => candidate.id === id) : undefined;
    if (statement !== undefined) {
      return { page, statement };
    }
  }
  return undefined;
}

/** A current statement on a shown page that already says this, if any. */
function alreadySaying({
  shown,
  kind,
  about,
  text,
}: {
  shown: readonly ShownPage[];
  kind: PageKind;
  about: string;
  text: string;
}): ShownStatement | undefined {
  const page = shown.find(candidate => candidate.kind === kind && candidate.slug === about);
  return page?.statements.find(
    statement =>
      statement.id !== undefined && statement.section !== 'Unconfirmed' && sameText({ a: statement.text, b: text }),
  );
}

function sameDecision({
  about,
  target,
  reason,
}: {
  about: string;
  target: ShownStatement;
  reason: string;
}): SortDecision | undefined {
  return target.id === undefined ? undefined : { decision: 'same', about, statement_id: target.id, reason };
}

/** `same`, `changed` and `ended`: they name a statement the prompt showed. */
function ruleExisting({
  decision,
  context,
}: {
  decision: Extract<SortDecision, { decision: 'same' | 'changed' | 'ended' }>;
  context: RuleContext;
}): Step {
  const { origin, day, shown, known } = context;
  if (!known.some(listing => listing.slug === decision.about)) {
    return refuse(`a decision names a page that does not exist: ${decision.about}`);
  }
  const found = shownTarget({ shown, about: decision.about, id: decision.statement_id });
  if (found === undefined) {
    return refuse(`a decision names a statement that was not shown: ${decision.statement_id}`);
  }
  const { page, statement } = found;
  const kind = page.kind;
  if (decision.decision === 'same') {
    return { ok: true, planned: { decision, kind, target: statement, guessed: false } };
  }
  const newText =
    decision.decision === 'changed'
      ? plain({ raw: decision.new_text, what: 'fact', limit: MAX_FACT_CHARS })
      : undefined;
  if (decision.decision === 'changed' && newText === undefined) {
    return refuse('a new statement is not a plain single line');
  }
  const mayTouch =
    origin.kind === 'own_words' || (origin.kind === 'sent_mail' && !OWN_STATEMENT_SOURCES.has(statement.src));
  // A replacement that holds a word found only in what Aman read changes nothing; it waits as a guess.
  const guessed = newText !== undefined && !wordedInOwnWords({ text: newText, context });
  if (mayTouch && !guessed) {
    if (decision.decision === 'changed' && newText !== undefined && sameText({ a: statement.text, b: newText })) {
      const same = sameDecision({ about: decision.about, target: statement, reason: decision.reason });
      return same === undefined
        ? refuse('a statement has no id')
        : { ok: true, planned: { decision: same, kind, target: statement, guessed: false } };
    }
    return {
      ok: true,
      planned: {
        decision:
          decision.decision === 'changed' && newText !== undefined ? { ...decision, new_text: newText } : decision,
        kind,
        target: statement,
        guessed: false,
      },
    };
  }
  // The note may not change this statement, so what it says waits as an unconfirmed line beside it.
  const waiting =
    newText ??
    plain({
      raw: `${statement.text} (may have ended by ${decision.decision === 'ended' ? decision.until : day})`,
      what: 'fact',
      limit: MAX_FACT_CHARS,
    });
  if (waiting === undefined) {
    return refuse('a statement that may have ended is not a plain single line');
  }
  return {
    ok: true,
    planned: {
      decision: {
        decision: 'unconfirmed',
        about: decision.about,
        page_kind: kind,
        text: waiting,
        seen: day,
        reason: decision.reason,
      },
      kind,
      target: undefined,
      guessed,
    },
  };
}

/** `new` and `unconfirmed`: they may start a page. */
function ruleNew({
  decision,
  context,
}: {
  decision: Extract<SortDecision, { decision: 'new' | 'unconfirmed' }>;
  context: RuleContext;
}): Step {
  const { origin, day, shown, known } = context;
  const text = plain({ raw: decision.text, what: 'fact', limit: MAX_FACT_CHARS });
  const givenTitle =
    decision.title === undefined ? undefined : plain({ raw: decision.title, what: 'name', limit: MAX_NAME_CHARS });
  // A page's name is shown as the person's own, so only their own words may choose it; otherwise the slug names it.
  const title =
    origin.kind === 'own_words' && givenTitle !== undefined && wordedInOwnWords({ text: givenTitle, context })
      ? givenTitle
      : undefined;
  if (text === undefined || (decision.title !== undefined && givenTitle === undefined)) {
    return refuse('a new statement or a page name is not a plain single line');
  }
  // A page already filed under the slug keeps its kind, whatever the model called it.
  const existing = known.filter(listing => listing.slug === decision.about);
  const kind = existing.some(listing => listing.kind === decision.page_kind)
    ? decision.page_kind
    : (existing[0]?.kind ?? decision.page_kind);
  // Only the writing section is for people alone; pages the person edits by hand may hold other sections anywhere.
  if (
    decision.decision === 'new' &&
    decision.section === WRITING_SECTION &&
    !kindHasSection({ kind, section: decision.section })
  ) {
    return refuse(`a ${kind} page has no section called ${decision.section}`);
  }
  const said = alreadySaying({ shown, kind, about: decision.about, text });
  const same =
    said === undefined ? undefined : sameDecision({ about: decision.about, target: said, reason: decision.reason });
  if (said !== undefined && same !== undefined) {
    return { ok: true, planned: { decision: same, kind, target: said, guessed: false } };
  }
  const guessed = !wordedInOwnWords({ text, context });
  const confirmed =
    decision.decision === 'new' &&
    !guessed &&
    (origin.kind === 'own_words' ||
      (origin.kind === 'sent_mail' && decision.section === WRITING_SECTION && kind === 'person'));
  if (decision.decision === 'new' && confirmed) {
    return {
      ok: true,
      planned: {
        // The title is set either way, so the model's own never rides along when the check dropped it.
        decision: { ...decision, page_kind: kind, text, title },
        kind,
        target: undefined,
        guessed: false,
      },
    };
  }
  return {
    ok: true,
    planned: {
      decision: {
        decision: 'unconfirmed',
        about: decision.about,
        page_kind: kind,
        ...(title === undefined ? {} : { title }),
        text,
        seen: decision.decision === 'unconfirmed' ? decision.seen : day,
        reason: decision.reason,
      },
      kind,
      target: undefined,
      guessed,
    },
  };
}

/**
 * Checks every decision against what the prompt showed and holds it to the note's origin. A decision the host
 * cannot trust refuses the whole reply, so a half-understood answer writes nothing.
 *
 * - The person's own words: every decision stands, unless a new or changed line holds a word found only in what
 *   Aman read. Such a line changes nothing and waits as an unconfirmed line marked as Aman's guess.
 * - A message the person sent: a new fact stands only as a line about how they write to someone; any other new
 *   fact is unconfirmed. It cannot change or end a statement the person said or wrote.
 * - Anything else: a new, changed or ended fact is only ever an unconfirmed line, and nothing confirmed is touched.
 * A fact a page already says is `same`.
 */
export function ruleDecisions({
  decisions,
  ...context
}: { decisions: readonly SortDecision[] } & RuleContext): RuledReply {
  const planned: PlannedDecision[] = [];
  for (const decision of decisions) {
    let step: Step;
    if (decision.decision === 'ignore') {
      step = { ok: true, planned: { decision, kind: undefined, target: undefined, guessed: false } };
    } else if (decision.decision === 'new' || decision.decision === 'unconfirmed') {
      step = ruleNew({ decision, context });
    } else {
      step = ruleExisting({ decision, context });
    }
    if (!step.ok) {
      return step;
    }
    planned.push(step.planned);
  }
  return { ok: true, planned };
}
