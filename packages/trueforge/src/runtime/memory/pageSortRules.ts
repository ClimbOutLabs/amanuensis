/**
 * What the host lets the model do with a note. The model's decisions are checked against the vault and then held
 * to the note's origin: the rules never read the note's text, so a note cannot talk its way into more.
 */
import { kindHasSection, type PageKind, type PageListing } from './memoryPages';
import type { SortDecision } from './pageSortDecisions';
import type { NoteOrigin } from './pageSortOrigin';
import type { ShownPage, ShownStatement } from './pageSortPrompt';
import { cleanLine, MAX_FACT_CHARS, MAX_NAME_CHARS, sameText } from './pageStatements';

/** One decision after the checks and the origin rules, with the page and statement it resolved to. */
export interface PlannedDecision {
  decision: SortDecision;
  /** The kind of the page the decision is about; undefined for `ignore`. */
  kind: PageKind | undefined;
  /** The statement a `same`, `changed` or `ended` decision names, as the prompt showed it. */
  target: ShownStatement | undefined;
}

export type RuledReply = { ok: true; planned: PlannedDecision[] } | { ok: false; reason: string };

const WRITING_SECTION = 'How you write to them';

/** Statements whose words are the person's own; a note that is not their own words may not change them. */
const OWN_SOURCES: ReadonlySet<ShownStatement['src']> = new Set(['you_said', 'you_edited', 'typed']);

interface RuleContext {
  origin: NoteOrigin;
  day: string;
  shown: readonly ShownPage[];
  known: readonly PageListing[];
}

type Step = { ok: true; planned: PlannedDecision } | { ok: false; reason: string };

function refuse(reason: string): Step {
  return { ok: false, reason };
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
    return { ok: true, planned: { decision, kind, target: statement } };
  }
  const newText =
    decision.decision === 'changed'
      ? plain({ raw: decision.new_text, what: 'fact', limit: MAX_FACT_CHARS })
      : undefined;
  if (decision.decision === 'changed' && newText === undefined) {
    return refuse('a new statement is not a plain single line');
  }
  const mayTouch = origin.kind === 'own_words' || (origin.kind === 'sent_mail' && !OWN_SOURCES.has(statement.src));
  if (mayTouch) {
    if (decision.decision === 'changed' && newText !== undefined && sameText({ a: statement.text, b: newText })) {
      const same = sameDecision({ about: decision.about, target: statement, reason: decision.reason });
      return same === undefined
        ? refuse('a statement has no id')
        : { ok: true, planned: { decision: same, kind, target: statement } };
    }
    return {
      ok: true,
      planned: {
        decision:
          decision.decision === 'changed' && newText !== undefined ? { ...decision, new_text: newText } : decision,
        kind,
        target: statement,
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
  const title =
    decision.title === undefined ? undefined : plain({ raw: decision.title, what: 'name', limit: MAX_NAME_CHARS });
  if (text === undefined || (decision.title !== undefined && title === undefined)) {
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
    return { ok: true, planned: { decision: same, kind, target: said } };
  }
  const confirmed =
    decision.decision === 'new' &&
    (origin.kind === 'own_words' ||
      (origin.kind === 'sent_mail' && decision.section === WRITING_SECTION && kind === 'person'));
  if (decision.decision === 'new' && confirmed) {
    return {
      ok: true,
      planned: {
        decision: { ...decision, page_kind: kind, text, ...(title === undefined ? {} : { title }) },
        kind,
        target: undefined,
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
    },
  };
}

/**
 * Checks every decision against what the prompt showed and holds it to the note's origin. A decision the host
 * cannot trust refuses the whole reply, so a half-understood answer writes nothing.
 *
 * - The person's own words: every decision stands.
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
      step = { ok: true, planned: { decision, kind: undefined, target: undefined } };
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
