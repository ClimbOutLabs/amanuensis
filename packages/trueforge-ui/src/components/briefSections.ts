import {
  BRIEF_SECTION_VALUES,
  briefItemKey,
  type BriefItem,
  type BriefSection,
  type MorningBrief,
} from '@truefoundry/trueforge-core/core/schedules/morningBrief';

export type { BriefItem, BriefSection, MorningBrief } from '@truefoundry/trueforge-core/core/schedules/morningBrief';

/** Section headings in the order they show. */
const BRIEF_SECTION_LABELS: Record<BriefSection, string> = {
  check_first: 'Check first',
  decision: 'Needs a decision',
  coming_up: 'Coming up',
  deadline: 'Deadlines',
};

/** Items shown before the "+ N more items" line. */
const BRIEF_VISIBLE_LIMIT = 6;

export type BriefViewItem = BriefItem & { key: string };

export type BriefViewSection = {
  section: BriefSection;
  label: string;
  /** Every item in the section, including ones hidden behind "+ N more items". */
  count: number;
  items: BriefViewItem[];
};

export type BriefView = {
  sections: BriefViewSection[];
  /** Items not shown because of the limit. */
  hiddenCount: number;
};

/**
 * The brief's sections for display. Items whose keys are in `hiddenKeys` are left out (done and undone-out),
 * then only the first `limit` items in display order show unless `expanded` is set.
 */
export function buildBriefView({
  brief,
  hiddenKeys,
  expanded,
  limit = BRIEF_VISIBLE_LIMIT,
}: {
  brief: MorningBrief;
  hiddenKeys: ReadonlySet<string>;
  expanded: boolean;
  limit?: number;
}): BriefView {
  // Items with the same section and title are one item, so only the first of them shows.
  const seen = new Set<string>();
  const live: BriefViewItem[] = brief.items
    .map(item => ({ ...item, key: briefItemKey({ section: item.section, title: item.title }) }))
    .filter(item => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return !hiddenKeys.has(item.key);
    });
  let budget = expanded ? Number.POSITIVE_INFINITY : limit;
  const sections: BriefViewSection[] = [];
  for (const section of BRIEF_SECTION_VALUES) {
    const items = live.filter(item => item.section === section);
    if (items.length === 0) continue;
    const shown = items.slice(0, Math.max(0, budget));
    budget -= shown.length;
    // A section whose items are all past the limit stays out, so no heading shows over nothing.
    if (shown.length === 0) continue;
    sections.push({ section, label: BRIEF_SECTION_LABELS[section], count: items.length, items: shown });
  }
  const shownCount = sections.reduce((total, section) => total + section.items.length, 0);
  return { sections, hiddenCount: live.length - shownCount };
}

/** The top bar's title for a brief: "Brief · Tuesday 21 October", cut to 40 characters. */
export function briefTopBarTitle(now: Date): string {
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  const title = `Brief · ${date}`;
  return title.length <= 40 ? title : `${title.slice(0, 39)}…`;
}

/** A calendar time for a Coming up row, in the browser's time zone: "Sun 25 / 3:30pm". */
export function briefWhenLabel(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(date)
    .replace(' ', '')
    .toLowerCase();
  return `${day} / ${time}`;
}

/** The line under a brief when some items did not fit and were left out. Empty when none were. */
export function briefOmittedLine(count: number): string {
  if (count <= 0) return '';
  return `${pluralize(count, 'item')} could not be shown. Ask for your brief again to try once more.`;
}

function pluralize(count: number, singular: string): string {
  return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

export type BriefAuditSummary = {
  /** Things Aman read without changing anything, from the chat's audit log. */
  readAllowed: number;
  /** Actions that ran or were approved. Zero means nothing was sent. */
  actionsRan: number;
};

/** Counts for the trust line, read from the chat's audit entries. Brief item marks are not counted. */
export function summarizeBriefAudit(entries: readonly { outcome: string; action_type: string }[]): BriefAuditSummary {
  let readAllowed = 0;
  let actionsRan = 0;
  for (const entry of entries) {
    if (entry.action_type.startsWith('brief.')) continue;
    if (entry.outcome === 'logged') readAllowed += 1;
    if (entry.outcome === 'ran' || entry.outcome === 'approved') actionsRan += 1;
  }
  return { readAllowed, actionsRan };
}

/** The trust line. Only counts the audit log holds; nothing is claimed about sends it does not show. */
export function briefFooterLine(summary: BriefAuditSummary): string {
  const parts: string[] = [];
  if (summary.readAllowed > 0) parts.push(`${pluralize(summary.readAllowed, 'thing')} read, allowed by your settings.`);
  parts.push(summary.actionsRan === 0 ? 'Nothing was sent.' : `${pluralize(summary.actionsRan, 'action')} ran.`);
  return parts.join(' ');
}
