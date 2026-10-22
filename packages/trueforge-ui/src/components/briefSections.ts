/**
 * Reads a morning brief answer into its four sections. The brief prompt asks for these headings in this
 * order, one line per item, with at most one bracketed next step at the end of a line.
 */

export const BRIEF_SECTION_IDS = ['coming_up', 'deadlines', 'needs_doing', 'watch_out'] as const;

export type BriefSectionId = (typeof BRIEF_SECTION_IDS)[number];

export const BRIEF_SECTION_TITLES: Record<BriefSectionId, string> = {
  coming_up: 'Coming up',
  deadlines: 'Deadlines',
  needs_doing: 'Needs doing',
  watch_out: 'Watch out',
};

export type BriefLine = {
  /** Stable within one brief: section and position. */
  id: string;
  text: string;
  /** The bracketed next step, such as "Draft a reply". Null when the line has none. */
  action: string | null;
};

export type BriefSection = {
  id: BriefSectionId;
  title: string;
  lines: BriefLine[];
};

const HEADING_TO_SECTION = new Map<string, BriefSectionId>(
  BRIEF_SECTION_IDS.map(id => [BRIEF_SECTION_TITLES[id].toLowerCase(), id]),
);

const TRAILING_ACTION = /\s*\[([^\]]+)\](?:\([^)]*\))?\s*$/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;

function headingSection(line: string): BriefSectionId | undefined {
  const bare = line
    .replace(/^#+\s*/, '')
    .replace(/[*_]/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
  return HEADING_TO_SECTION.get(bare);
}

function parseLine({ section, index, raw }: { section: BriefSectionId; index: number; raw: string }): BriefLine {
  const body = raw.replace(LIST_MARKER, '').trim();
  const match = TRAILING_ACTION.exec(body);
  const action = match?.[1]?.trim() ?? null;
  const text = match === null ? body : body.slice(0, match.index).trim();
  return { id: `${section}-${String(index)}`, text, action: action === '' ? null : action };
}

/**
 * The four sections of a brief answer, or null when the answer has none of the headings. Text before
 * the first heading is not part of any section.
 */
export function parseBrief(markdown: string): BriefSection[] | null {
  const lines: Record<BriefSectionId, BriefLine[]> = { coming_up: [], deadlines: [], needs_doing: [], watch_out: [] };
  let current: BriefSectionId | null = null;
  let found = false;
  for (const raw of markdown.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const heading = headingSection(trimmed);
    if (heading !== undefined) {
      current = heading;
      found = true;
      continue;
    }
    if (current === null) continue;
    const section: BriefSectionId = current;
    const line = parseLine({ section, index: lines[section].length, raw: trimmed });
    if (line.text !== '') lines[section].push(line);
  }
  if (!found) return null;
  return BRIEF_SECTION_IDS.map(id => ({ id, title: BRIEF_SECTION_TITLES[id], lines: lines[id] }));
}

export type BriefAuditSummary = {
  /** Things Aman read without changing anything, from the chat's audit log. */
  readAllowed: number;
  /** Actions that ran or were approved. Zero means nothing was sent. */
  actionsRan: number;
};

/** Counts for the brief's footer, read from the chat's audit entries. */
export function summarizeBriefAudit(entries: readonly { outcome: string }[]): BriefAuditSummary {
  let readAllowed = 0;
  let actionsRan = 0;
  for (const entry of entries) {
    if (entry.outcome === 'logged') readAllowed += 1;
    if (entry.outcome === 'ran' || entry.outcome === 'approved') actionsRan += 1;
  }
  return { readAllowed, actionsRan };
}
