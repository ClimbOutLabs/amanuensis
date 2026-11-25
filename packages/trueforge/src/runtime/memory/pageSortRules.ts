/**
 * What the host lets the model do with a note. The model's decisions are checked against the vault and then held
 * to the note's origin, so a note cannot talk its way into more. The note's text is read for one thing only, and
 * only to take away: a line the model worded with a word found only in what Aman read is not marked as theirs.
 * The host also holds each decision to the page of its subject: the person's own page and the assistant's page
 * are never destinations, a new or changed line must be about the person or matter its page is about and name
 * them, and one statement gets one home, so a fact cannot be copied onto a second page.
 */
import { normalizeAliasText } from './aliasIndex';
import { kindHasSection, type PageKind, type PageListing } from './memoryPages';
import { holdsWordOnlyRead } from './memorySummarize';
import type { SortDecision } from './pageSortDecisions';
import type { SortableOrigin } from './pageSortOrigin';
import {
  OWN_STATEMENT_SOURCES,
  pageKey,
  type ShownPage,
  type ShownStatement,
  type ShownWords,
  type SortIdentity,
} from './pageSortPrompt';
import { cleanLine, MAX_FACT_CHARS, MAX_NAME_CHARS, nearlySameText, sameText } from './pageStatements';
import { QUERY_STOPWORDS } from './stopWords';

/** One decision after the checks and the origin rules, with the page and statement it resolved to. */
export interface PlannedDecision {
  decision: SortDecision;
  /** The kind of the page the decision is about; undefined for `ignore`. */
  kind: PageKind | undefined;
  /** The statement a `same`, `changed` or `ended` decision names, as the prompt showed it. */
  target: ShownStatement | undefined;
  /**
   * True when the line holds a word found only in what Aman read, such as a word from a read line the model was
   * shown. The line is written as one Aman worked out from the person's conversations, never as the person's.
   */
  inferred: boolean;
}

export type RuledReply = { ok: true; planned: PlannedDecision[] } | { ok: false; reason: string };

const WRITING_SECTION = 'How you write to them';

interface RuleContext {
  origin: SortableOrigin;
  /** The note being sorted. Compared with the model's wording, never obeyed. */
  noteText: string;
  day: string;
  shown: readonly ShownPage[];
  known: readonly PageListing[];
  /** What the prompt showed besides the note, split by whose words it is. */
  words: ShownWords;
  /** The vault owner's and the assistant's names and pages, resolved by the prompt. */
  identity: SortIdentity;
  /** Every readable page's title and other names, by page key. */
  pageNames: ReadonlyMap<string, { title: string; aliases: readonly string[] }>;
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
      statement.id !== undefined &&
      statement.section !== 'Unconfirmed' &&
      nearlySameText({ a: statement.text, b: text }),
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

/** A text as the words a name check reads, folded the way names are matched everywhere. */
function nameTokens(text: string): string[] {
  return (
    normalizeAliasText(text)
      .split(' ')
      .filter(token => token !== '')
      // A possessive still names its page, as the alias matching already holds: "Tomás's" names Tomás.
      .map(token => (token.endsWith("'s") ? token.slice(0, -2) : token.endsWith("'") ? token.slice(0, -1) : token))
  );
}

/** Whether a run of words appears in a text, word for word and in order. */
function holdsRun({ tokens, run }: { tokens: readonly string[]; run: readonly string[] }): boolean {
  if (run.length === 0 || run.length > tokens.length) {
    return false;
  }
  for (let start = 0; start + run.length <= tokens.length; start += 1) {
    if (run.every((word, offset) => tokens[start + offset] === word)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a statement names the subject of the page it is filed on. A person page is named by its title, by one
 * of its other names, or by the person's given name. A matter page is named by a word of its title or other
 * names that carries the topic. A statement that names neither is about something else, however often the page
 * is shown and however often its name comes up in conversation.
 */
export function statementNamesItsPage({
  text,
  kind,
  title,
  aliases,
}: {
  text: string;
  kind: PageKind;
  title: string;
  aliases: readonly string[];
}): boolean {
  const tokens = nameTokens(text);
  if (kind === 'matter') {
    const topics = new Set(
      [title, ...aliases]
        .flatMap(name => nameTokens(name))
        .filter(token => token.length >= 3 && !QUERY_STOPWORDS.has(token)),
    );
    return tokens.some(token => topics.has(token));
  }
  const named = [title, ...aliases].some(name => holdsRun({ tokens, run: nameTokens(name) }));
  const given = nameTokens(title)[0];
  return named || (given !== undefined && given.length >= 2 && tokens.includes(given));
}

/**
 * Verbs that make the name before them a participant rather than the subject of what follows: the person is
 * the one who said it, or the one who passed a thing on. A name after one of the addressed verbs is the one
 * spoken or written to, a participant the same way.
 */
const SPEAKING_VERBS: ReadonlySet<string> = new Set([
  'told',
  'said',
  'says',
  'asked',
  'asks',
  'mentioned',
  'mentions',
  'noted',
  'notes',
  'wrote',
  'writes',
  'emailed',
  'emails',
  'texted',
  'texts',
  'messaged',
  'called',
  'calls',
  'reported',
  'reports',
  'explained',
  'explains',
  'replied',
  'replies',
  'answered',
  'answers',
  'claimed',
  'claims',
  'suggested',
  'suggests',
  'added',
  'adds',
  'announced',
  'announces',
  'reminded',
  'reminds',
  'thinks',
  'thought',
  'believes',
  'believed',
  'reckons',
]);
const PASSING_VERBS: ReadonlySet<string> = new Set([
  'forwarded',
  'forwards',
  'sent',
  'sends',
  'handed',
  'hands',
  'gave',
  'gives',
  'passed',
  'passes',
  'delivered',
  'delivers',
  'mailed',
  'mails',
  'posted',
  'posts',
  'shared',
  'shares',
]);
const ADDRESSED_VERBS: ReadonlySet<string> = new Set([
  'told',
  'asked',
  'emailed',
  'texted',
  'messaged',
  'called',
  'wrote',
  'reminded',
]);

/** Words for a document a person may pass on; a statement about one is about the document's matter. */
const DOCUMENT_WORDS: ReadonlySet<string> = new Set([
  'estimate',
  'estimates',
  'invoice',
  'invoices',
  'quote',
  'quotes',
  'quotation',
  'form',
  'forms',
  'document',
  'documents',
  'report',
  'reports',
  'letter',
  'letters',
  'bill',
  'bills',
  'receipt',
  'receipts',
  'contract',
  'contracts',
  'application',
  'applications',
  'paperwork',
  'agreement',
  'agreements',
  'certificate',
  'certificates',
  'permit',
  'permits',
  'licence',
  'licences',
  'license',
  'licenses',
  'file',
  'files',
]);

/** One place a person's page is named in a statement, as the token span it covers. */
interface NameMention {
  page: string;
  start: number;
  end: number;
}

/**
 * Every mention of a person's page in a statement's words: full names and other names as runs of words, and a
 * given name as a single word where a fuller name does not already cover it.
 */
function personMentions({
  tokens,
  pageNames,
}: {
  tokens: readonly string[];
  pageNames: RuleContext['pageNames'];
}): NameMention[] {
  const mentions: NameMention[] = [];
  for (const [key, names] of pageNames) {
    if (!key.startsWith('person/')) {
      continue;
    }
    const covered = new Set<number>();
    for (const name of [names.title, ...names.aliases]) {
      const run = nameTokens(name);
      if (run.length === 0) {
        continue;
      }
      for (let start = 0; start + run.length <= tokens.length; start += 1) {
        if (run.every((word, offset) => tokens[start + offset] === word)) {
          mentions.push({ page: key, start, end: start + run.length });
          for (let at = start; at < start + run.length; at += 1) {
            covered.add(at);
          }
        }
      }
    }
    const given = nameTokens(names.title)[0];
    if (given !== undefined && given.length >= 2) {
      tokens.forEach((token, at) => {
        if (token === given && !covered.has(at)) {
          mentions.push({ page: key, start: at, end: at + 1 });
        }
      });
    }
  }
  return mentions;
}

/** Whether a mention names its person only as a participant: speaking, passing a thing on, or spoken to. */
function mentionIsParticipant({ tokens, mention }: { tokens: readonly string[]; mention: NameMention }): boolean {
  const after = tokens[mention.end];
  const before = tokens[mention.start - 1];
  return (
    (after !== undefined && (SPEAKING_VERBS.has(after) || PASSING_VERBS.has(after))) ||
    (before !== undefined && ADDRESSED_VERBS.has(before))
  );
}

/**
 * Whether a statement filed on a person's page is about another subject, though it names that person. It is,
 * when every mention of the page's person names them only as a participant, the one who said it or passed it
 * on or was spoken to, and the statement itself names what it is about instead: another person outside that
 * frame, a matter by a topic word of its page, or a document. When the person's part cannot be told apart
 * this way, the statement is not judged here and the naming check alone decides, so an unclear case keeps
 * the page it was given rather than losing it on a guess.
 */
function statementAboutAnotherSubject({
  text,
  kind,
  slug,
  context,
}: {
  text: string;
  kind: PageKind;
  slug: string;
  context: RuleContext;
}): boolean {
  if (kind !== 'person') {
    return false;
  }
  const tokens = nameTokens(text);
  const self = pageKey({ kind, slug });
  const mentions = personMentions({ tokens, pageNames: context.pageNames });
  const own = mentions.filter(mention => mention.page === self);
  if (own.length === 0 || !own.every(mention => mentionIsParticipant({ tokens, mention }))) {
    return false;
  }
  const overlapsOwn = (mention: NameMention): boolean =>
    own.some(other => mention.start < other.end && other.start < mention.end);
  const anotherPerson = mentions.some(
    mention => mention.page !== self && !overlapsOwn(mention) && !mentionIsParticipant({ tokens, mention }),
  );
  if (anotherPerson) {
    return true;
  }
  const topics = new Set<string>();
  for (const [key, names] of context.pageNames) {
    if (!key.startsWith('matter/')) {
      continue;
    }
    for (const name of [names.title, ...names.aliases]) {
      for (const token of nameTokens(name)) {
        if (token.length >= 3 && !QUERY_STOPWORDS.has(token)) {
          topics.add(token);
        }
      }
    }
  }
  return tokens.some(token => topics.has(token) || DOCUMENT_WORDS.has(token));
}

/** Whether the page a decision names is one resolved identity page, when one was resolved. */
function isIdentityPage(
  page: { kind: PageKind; slug: string } | undefined,
  target: { kind: PageKind; about: string },
): boolean {
  return page?.kind === target.kind && page.slug === target.about;
}

/**
 * Why a decision may not go to this existing page at all, when it may not. The person's own page belongs to
 * their profile, and the assistant only took part in the conversation: sorting never writes to either page.
 */
function blockedDestination({
  about,
  kind,
  context,
}: {
  about: string;
  kind: PageKind;
  context: RuleContext;
}): string | undefined {
  const { identity } = context;
  if (isIdentityPage(identity.personPage, { kind, about })) {
    return "a decision files a fact on the person's own page, which sorting never writes";
  }
  if (isIdentityPage(identity.assistantPage, { kind, about })) {
    return "a decision files a fact on the assistant's page, which sorting never writes";
  }
  return undefined;
}

/**
 * Whether a folded page name is this person's name: their full name, or their given name alone. A new page is
 * as often titled with the given name as with the whole name, and either title starts the same page.
 */
function nameStartsTheirPage({ folded, name }: { folded: string; name: string }): boolean {
  const foldedName = normalizeAliasText(name);
  if (folded === foldedName) {
    return true;
  }
  const given = foldedName.split(' ')[0];
  return given !== undefined && given !== '' && folded === given;
}

/** Why a decision may not start this page, when it may not: a new page for the person or for the assistant. */
function blockedNewPage({
  decision,
  kind,
  context,
}: {
  decision: Extract<SortDecision, { decision: 'new' | 'unconfirmed' }>;
  kind: PageKind;
  context: RuleContext;
}): string | undefined {
  if (kind !== 'person') {
    return undefined;
  }
  const { identity } = context;
  const folded = normalizeAliasText(decision.title ?? decision.about.replaceAll('-', ' '));
  if (
    identity.personName !== undefined &&
    folded !== '' &&
    nameStartsTheirPage({ folded, name: identity.personName })
  ) {
    return 'a decision starts a page for the person themselves';
  }
  if (
    identity.assistantName !== undefined &&
    folded !== '' &&
    nameStartsTheirPage({ folded, name: identity.assistantName })
  ) {
    return 'a decision starts a page for the assistant';
  }
  return undefined;
}

/** A current statement on another shown page that already says this, if any. */
function saidOnAnotherPage({
  shown,
  kind,
  about,
  text,
}: {
  shown: readonly ShownPage[];
  kind: PageKind;
  about: string;
  text: string;
}): boolean {
  return shown.some(
    page =>
      !(page.kind === kind && page.slug === about) &&
      page.statements.some(statement => statement.id !== undefined && nearlySameText({ a: statement.text, b: text })),
  );
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
  const blocked = blockedDestination({ about: decision.about, kind, context });
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  if (decision.decision === 'same') {
    return { ok: true, planned: { decision, kind, target: statement, inferred: false } };
  }
  const newText =
    decision.decision === 'changed'
      ? plain({ raw: decision.new_text, what: 'fact', limit: MAX_FACT_CHARS })
      : undefined;
  if (decision.decision === 'changed' && newText === undefined) {
    return refuse('a new statement is not a plain single line');
  }
  // A change is held to the checks a new line is held to: its words must be about the page's subject, and
  // they may not copy a statement this page or another page already holds.
  if (decision.decision === 'changed' && newText !== undefined) {
    const names = context.pageNames.get(pageKey({ kind, slug: decision.about }));
    if (
      !statementNamesItsPage({
        text: newText,
        kind,
        title: names?.title ?? page.title,
        aliases: names?.aliases ?? [],
      })
    ) {
      return refuse('a changed fact does not name the person or matter its page is about');
    }
    if (statementAboutAnotherSubject({ text: newText, kind, slug: decision.about, context })) {
      return refuse(
        'a changed fact names the person of its page only as the one who said it or passed it on, and is about another subject',
      );
    }
    const copied = page.statements.find(
      candidate =>
        candidate.id !== undefined &&
        candidate.id !== statement.id &&
        candidate.section !== 'Unconfirmed' &&
        nearlySameText({ a: candidate.text, b: newText }),
    );
    if (copied !== undefined) {
      return refuse('a changed fact copies a statement its page already holds');
    }
    if (saidOnAnotherPage({ shown, kind, about: decision.about, text: newText })) {
      return refuse('a fact is filed on a second page when a page already says it');
    }
  }
  const mayTouch =
    origin.kind === 'own_words' || (origin.kind === 'sent_mail' && !OWN_STATEMENT_SOURCES.has(statement.src));
  // A replacement that holds a word found only in what Aman read changes nothing; it waits as an inferred line.
  const inferred = newText !== undefined && !wordedInOwnWords({ text: newText, context });
  if (mayTouch && !inferred) {
    if (decision.decision === 'changed' && newText !== undefined && sameText({ a: statement.text, b: newText })) {
      const same = sameDecision({ about: decision.about, target: statement, reason: decision.reason });
      return same === undefined
        ? refuse('a statement has no id')
        : { ok: true, planned: { decision: same, kind, target: statement, inferred: false } };
    }
    return {
      ok: true,
      planned: {
        decision:
          decision.decision === 'changed' && newText !== undefined ? { ...decision, new_text: newText } : decision,
        kind,
        target: statement,
        inferred: false,
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
      inferred,
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
  const blocked =
    existing.length === 0
      ? blockedNewPage({ decision, kind, context })
      : blockedDestination({ about: decision.about, kind, context });
  if (blocked !== undefined) {
    return refuse(blocked);
  }
  const said = alreadySaying({ shown, kind, about: decision.about, text });
  const same =
    said === undefined ? undefined : sameDecision({ about: decision.about, target: said, reason: decision.reason });
  if (said !== undefined && same !== undefined) {
    return { ok: true, planned: { decision: same, kind, target: said, inferred: false } };
  }
  if (saidOnAnotherPage({ shown, kind, about: decision.about, text })) {
    return refuse('a fact is filed on a second page when a page already says it');
  }
  // Every new line must name the person or matter its page is about, a line about how the person writes to
  // someone included: the section a line is filed under never exempts it from the check. Naming the person
  // is not enough on its own when the line is about another subject and names them only as a participant.
  const names = context.pageNames.get(pageKey({ kind, slug: decision.about }));
  const namesSubject = statementNamesItsPage({
    text,
    kind,
    // The name the page carries or will carry: its own title, or the title the host kept, or its slug.
    title: names?.title ?? title ?? decision.about.replaceAll('-', ' '),
    aliases: names?.aliases ?? [],
  });
  if (!namesSubject) {
    return refuse('a new fact does not name the person or matter its page is about');
  }
  if (statementAboutAnotherSubject({ text, kind, slug: decision.about, context })) {
    return refuse(
      'a new fact names the person of its page only as the one who said it or passed it on, and is about another subject',
    );
  }
  const inferred = !wordedInOwnWords({ text, context });
  const confirmed =
    decision.decision === 'new' &&
    !inferred &&
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
        inferred: false,
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
      inferred,
    },
  };
}

/**
 * Checks every decision against what the prompt showed and holds it to the note's origin. A decision the host
 * cannot trust refuses the whole reply, so a half-understood answer writes nothing.
 *
 * - The person's own words: every decision stands, unless a new or changed line holds a word found only in what
 *   Aman read. Such a line changes nothing and waits as an unconfirmed line marked as worked out from the
 *   person's conversations.
 * - A message the person sent: a new fact stands only as a line about how they write to someone; any other new
 *   fact is unconfirmed. It cannot change or end a statement the person said or wrote.
 * - Anything else: a new, changed or ended fact is only ever an unconfirmed line, and nothing confirmed is touched.
 * A fact a page already says is `same`. Whatever the origin, no decision goes to the person's own page or the
 * assistant's page, a new line names the subject of its page, and the same line is never filed on two pages.
 */
export function ruleDecisions({
  decisions,
  ...context
}: { decisions: readonly SortDecision[] } & RuleContext): RuledReply {
  const planned: PlannedDecision[] = [];
  const filed: { text: string; about: string }[] = [];
  for (const decision of decisions) {
    let step: Step;
    if (decision.decision === 'ignore') {
      step = { ok: true, planned: { decision, kind: undefined, target: undefined, inferred: false } };
    } else if (decision.decision === 'new' || decision.decision === 'unconfirmed') {
      step = ruleNew({ decision, context });
    } else {
      step = ruleExisting({ decision, context });
    }
    if (!step.ok) {
      return step;
    }
    // One statement gets one home within a reply as well: a fact filed, waited or changed into being by one
    // decision may not be filed on another page by a second one, in the same words or nearly the same.
    const plannedDecision = step.planned.decision;
    const filedText =
      plannedDecision.decision === 'new' || plannedDecision.decision === 'unconfirmed'
        ? { text: plannedDecision.text, about: plannedDecision.about }
        : plannedDecision.decision === 'changed'
          ? { text: plannedDecision.new_text, about: plannedDecision.about }
          : undefined;
    if (filedText !== undefined) {
      if (
        filed.some(entry => entry.about !== filedText.about && nearlySameText({ a: entry.text, b: filedText.text }))
      ) {
        return { ok: false, reason: 'the same fact is filed on two pages' };
      }
      filed.push(filedText);
    }
    planned.push(step.planned);
  }
  return { ok: true, planned };
}
