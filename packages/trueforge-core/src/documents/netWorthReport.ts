import { sourceForLine, type DocumentExtraction, type DocumentSource } from './documentExtraction';
import { DOCUMENT_REPORT_MAX_NOTES, type StructuredDocumentReport } from './documentRenderer';
import { ReportInputError } from './reportInputError';

export type NetWorthClassification = 'asset' | 'liability';
export type NetWorthEntryStatus = 'included' | 'conflict' | 'uncertain';

export interface NetWorthObservationInput {
  key: string;
  label: string;
  classification: NetWorthClassification;
  amount_cents: number;
  source: DocumentSource;
}

export interface NetWorthEntry {
  key: string;
  label: string;
  classification: NetWorthClassification | 'unknown';
  amount_cents: number;
  status: NetWorthEntryStatus;
  sources: DocumentSource[];
  conflicting_amount_cents: number[];
}

export interface NetWorthReport {
  draft: true;
  entries: NetWorthEntry[];
  assets_cents: number;
  liabilities_cents: number;
  net_worth_cents: number;
  review_items: string[];
}

function parseMoney(value: string): number | null {
  const negative = value.includes('-') || (value.trim().startsWith('(') && value.trim().endsWith(')'));
  const normalized = value.replace(/[()$\s,]|USD|dollars?/gi, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }
  const [whole = '0', fraction = ''] = normalized.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const signed = negative ? -cents : cents;
  const amount = Number(signed);
  return Number.isSafeInteger(amount) ? amount : null;
}

function parseCitedMoney(text: string): number | null {
  const value = text.trim();
  const currencyMarked = /^\(?\s*-?\s*(?:(?:USD\s*)?\$\s*|USD\s+)\d[\d,]*(?:\.\d{1,2})?\s*(?:dollars?)?\s*\)?$/i;
  const unmarkedDecimal = /^\(?\s*-?\s*(?:\d{1,3}(?:,\d{3})+|\d{1,3})\.\d{2}\s*\)?$/;
  return currencyMarked.test(value) || unmarkedDecimal.test(value) ? parseMoney(value) : null;
}

function sourceIdentity(source: DocumentSource): string {
  return [source.sha256, source.page, source.line, source.start, source.end].join(':');
}

function validateSource(
  extraction: DocumentExtraction,
  observation: NetWorthObservationInput,
): { source: DocumentSource; issue: null } | { source: null; issue: string } {
  const source = observation.source;
  if (!Number.isSafeInteger(observation.amount_cents) || observation.amount_cents < 0) {
    return { source: null, issue: `${observation.label}: amount must be a non-negative safe integer in cents.` };
  }
  const document = extraction.documents.find(
    candidate => candidate.path === source.path && candidate.sha256 === source.sha256,
  );
  if (!document) {
    return { source: null, issue: `${observation.label}: source hash/path does not match extracted evidence.` };
  }
  if (source.filename !== document.filename) {
    return { source: null, issue: `${observation.label}: source filename does not match extracted evidence.` };
  }
  const page = document.pages.find(candidate => candidate.page_number === source.page);
  const line = page?.lines.find(candidate => candidate.line_number === source.line);
  if (!page || !line || source.start < 0 || source.end < source.start || source.end > line.text.length) {
    return { source: null, issue: `${observation.label}: source page/line/span is not present in extracted evidence.` };
  }
  if (source.extraction_mode !== page.extraction_mode) {
    return { source: null, issue: `${observation.label}: source extraction mode does not match extracted evidence.` };
  }
  if (line.text.slice(source.start, source.end) !== source.span_text) {
    return { source: null, issue: `${observation.label}: cited source span does not match extracted text.` };
  }
  if (parseCitedMoney(source.span_text) !== observation.amount_cents) {
    return {
      source: null,
      issue: `${observation.label}: cited source span is not exactly the claimed monetary amount.`,
    };
  }
  const canonical = sourceForLine({
    document,
    page: source.page,
    line: source.line,
    start: source.start,
    end: source.end,
  });
  return canonical === null
    ? { source: null, issue: `${observation.label}: source could not be canonicalized.` }
    : { source: canonical, issue: null };
}

export function summarizeNetWorth(
  extraction: DocumentExtraction,
  observations: readonly NetWorthObservationInput[],
): NetWorthReport {
  const valid: NetWorthObservationInput[] = [];
  const entries: NetWorthEntry[] = [];
  const review_items = extraction.documents
    .filter(document => document.issue !== null)
    .map(document => `${document.filename}: ${document.issue ?? 'unavailable'}`);

  for (const observation of observations) {
    const validation = validateSource(extraction, observation);
    if (validation.source === null) {
      review_items.push(validation.issue);
      entries.push({
        key: observation.key,
        label: observation.label,
        classification: 'unknown',
        amount_cents: observation.amount_cents,
        status: 'uncertain',
        sources: [],
        conflicting_amount_cents: [],
      });
    } else {
      valid.push({ ...observation, source: validation.source });
    }
  }

  const groups = new Map<string, NetWorthObservationInput[]>();
  for (const observation of valid) {
    const group = groups.get(observation.key) ?? [];
    group.push(observation);
    groups.set(observation.key, group);
  }
  const keysByEvidence = new Map<string, Set<string>>();
  for (const observation of valid) {
    const identity = sourceIdentity(observation.source);
    const keys = keysByEvidence.get(identity) ?? new Set<string>();
    keys.add(observation.key);
    keysByEvidence.set(identity, keys);
  }
  const evidenceUsedByMultipleKeys = new Set([...keysByEvidence].filter(([, keys]) => keys.size > 1).map(([id]) => id));
  for (const [key, group] of groups) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const amounts = [...new Set(group.map(item => item.amount_cents))].sort((a, b) => a - b);
    const classifications = [...new Set(group.map(item => item.classification))];
    const sourceIdentities = new Set(group.map(item => sourceIdentity(item.source)));
    const duplicateEvidence = group.some(item => evidenceUsedByMultipleKeys.has(sourceIdentity(item.source)));
    const conflict = duplicateEvidence || sourceIdentities.size > 1 || amounts.length > 1 || classifications.length > 1;
    entries.push({
      key,
      label: first.label,
      classification: classifications.length === 1 ? (classifications[0] ?? 'unknown') : 'unknown',
      amount_cents: first.amount_cents,
      status: conflict ? 'conflict' : 'included',
      sources: group.map(item => item.source),
      conflicting_amount_cents: conflict ? amounts : [],
    });
    if (conflict) {
      review_items.push(
        duplicateEvidence
          ? `${first.label}: the same cited evidence was assigned to multiple entries and was excluded from totals.`
          : `${first.label}: conflicting cited observations were excluded from totals.`,
      );
    }
  }

  const included = entries.filter(entry => entry.status === 'included');
  const assets_cents = included
    .filter(entry => entry.classification === 'asset')
    .reduce((total, entry) => safeAdd(total, entry.amount_cents), 0);
  const liabilities_cents = included
    .filter(entry => entry.classification === 'liability')
    .reduce((total, entry) => safeAdd(total, Math.abs(entry.amount_cents)), 0);
  const net_worth_cents = assets_cents - liabilities_cents;
  if (!Number.isSafeInteger(net_worth_cents)) {
    throw new ReportInputError('Net-worth total exceeds the safe integer range');
  }
  return {
    draft: true,
    entries: entries.sort((left, right) => left.label.localeCompare(right.label)),
    assets_cents,
    liabilities_cents,
    net_worth_cents,
    review_items,
  };
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new ReportInputError('Report total exceeds the safe integer range');
  }
  return total;
}

function formatCents(amount_cents: number): string {
  return new Intl.NumberFormat('en-US', { currency: 'USD', style: 'currency' }).format(amount_cents / 100);
}

export function netWorthAsDocumentReport(report: NetWorthReport, title: string): StructuredDocumentReport {
  const baseNotes = [
    'DRAFT: classifications, source matching, and exclusions require human review.',
    'The DOCX is a compact summary. The tool result retains the complete structured audit record.',
  ];
  const availableReviewNotes = DOCUMENT_REPORT_MAX_NOTES - baseNotes.length;
  const reviewNotes =
    report.review_items.length <= availableReviewNotes
      ? report.review_items
      : [
          ...report.review_items.slice(0, Math.max(0, availableReviewNotes - 1)),
          `${String(report.review_items.length - Math.max(0, availableReviewNotes - 1))} additional review items remain in the structured audit record.`,
        ];
  return {
    title,
    summary: `DRAFT SUMMARY | Net worth ${formatCents(report.net_worth_cents)} | Assets ${formatCents(report.assets_cents)} | Liabilities ${formatCents(report.liabilities_cents)}`,
    sections: [
      {
        heading: 'Cited observations',
        rows: report.entries.map(entry => ({
          label: entry.label,
          value:
            entry.status === 'included'
              ? formatCents(entry.amount_cents)
              : entry.conflicting_amount_cents.length > 0
                ? `Excluded conflict: ${entry.conflicting_amount_cents.map(formatCents).join(', ')}`
                : 'Excluded from total',
          status: entry.status,
          sources: entry.sources.map(
            source =>
              `${source.filename} p.${String(source.page)} l.${String(source.line)} ${source.extraction_mode} sha256:${source.sha256.slice(0, 12)} span:${String(source.start)}-${String(source.end)}`,
          ),
        })),
      },
    ],
    notes: [...baseNotes, ...reviewNotes],
  };
}
