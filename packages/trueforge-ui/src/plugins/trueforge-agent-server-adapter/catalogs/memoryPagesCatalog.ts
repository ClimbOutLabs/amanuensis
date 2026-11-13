import { z } from 'zod';

import type { CreateTrueForgeClientOptions } from '../client.js';
import { createMemoryRequester } from './memoryRequest.js';

const PAGE_KINDS = ['person', 'matter'] as const;
const PageKindSchema = z.enum(PAGE_KINDS);
export type MemoryPageKind = z.infer<typeof PageKindSchema>;

const PageSummarySchema = z
  .object({
    kind: PageKindSchema,
    slug: z.string(),
    title: z.string(),
    other_names: z.array(z.string()),
    summary: z.string().nullable(),
    changed_on: z.string().nullable(),
    unconfirmed_count: z.number(),
    // Absent from a server that predates the nightly check.
    disagreement_count: z.number().default(0),
  })
  .transform(page => ({
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    otherNames: page.other_names,
    summary: page.summary,
    changedOn: page.changed_on,
    unconfirmedCount: page.unconfirmed_count,
    disagreementCount: page.disagreement_count,
  }));

const PageLineSchema = z
  .object({
    id: z.string().nullable(),
    text: z.string(),
    source: z.string(),
    source_label: z.string(),
    since: z.string().nullable(),
    until: z.string().nullable(),
    seen: z.string().nullable(),
  })
  .transform(line => ({
    id: line.id,
    text: line.text,
    source: line.source,
    sourceLabel: line.source_label,
    since: line.since,
    until: line.until,
    seen: line.seen,
  }));

const DisagreementLineSchema = z.object({ id: z.string(), text: z.string() });

const DisagreementSchema = z
  .object({
    id: z.string(),
    first: DisagreementLineSchema,
    second: DisagreementLineSchema,
    reason: z.string(),
    found_on: z.string(),
  })
  .transform(pair => ({
    id: pair.id,
    first: pair.first,
    second: pair.second,
    reason: pair.reason,
    foundOn: pair.found_on,
  }));

const PageSchema = z
  .object({
    kind: PageKindSchema,
    slug: z.string(),
    title: z.string(),
    other_names: z.array(z.string()),
    summary: z.string().nullable(),
    sections: z.array(z.object({ name: z.string(), lines: z.array(PageLineSchema) })),
    text: z.string(),
    confirmable_sections: z.array(z.string()),
    version: z.string(),
    disagreements: z.array(DisagreementSchema).default([]),
  })
  .transform(page => ({
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    otherNames: page.other_names,
    summary: page.summary,
    sections: page.sections,
    text: page.text,
    confirmableSections: page.confirmable_sections,
    version: page.version,
    disagreements: page.disagreements,
  }));

const ListingSchema = z
  .object({ pages: z.array(PageSummarySchema), skipped_files: z.array(z.string()) })
  .transform(listing => ({ pages: listing.pages, skippedFiles: listing.skipped_files }));

export type MemoryPageSummary = z.output<typeof PageSummarySchema>;
export type MemoryPageLine = z.output<typeof PageLineSchema>;
export type MemoryPageDisagreement = z.output<typeof DisagreementSchema>;
export type MemoryPageDetail = z.output<typeof PageSchema>;
export type MemoryPageListing = z.output<typeof ListingSchema>;

/** One page, named by kind and name, in one collection (the shared one when `namespace` is omitted). */
export interface MemoryPageTarget {
  kind: MemoryPageKind;
  slug: string;
  namespace?: string | undefined;
}

export interface MemoryPagesCatalog {
  listPages(namespace?: string): Promise<MemoryPageListing>;
  getPage(target: MemoryPageTarget): Promise<MemoryPageDetail>;
  savePage(options: MemoryPageTarget & { text: string; version: string }): Promise<MemoryPageDetail>;
  confirmLine(options: MemoryPageTarget & { factId: string; section?: string | undefined }): Promise<MemoryPageDetail>;
  dismissLine(options: MemoryPageTarget & { factId: string }): Promise<MemoryPageDetail>;
  dismissDisagreement(options: MemoryPageTarget & { disagreementId: string }): Promise<MemoryPageDetail>;
  deletePage(target: MemoryPageTarget): Promise<void>;
}

const BASE = '/api/v1/memory/pages';

/** Calls the memory pages routes the same way the vault catalog calls the vault routes. */
export function createMemoryPagesCatalog(options: CreateTrueForgeClientOptions = {}): MemoryPagesCatalog {
  const { request, namespaceQuery } = createMemoryRequester(options);

  function parseData<Output>(schema: z.ZodType<Output>) {
    return (body: unknown): Output => {
      const envelope = z.object({ data: z.unknown() }).safeParse(body);
      const parsed = envelope.success ? schema.safeParse(envelope.data.data) : undefined;
      if (parsed?.success !== true) {
        throw new Error('The server returned an unexpected memory payload');
      }
      return parsed.data;
    };
  }

  const pagePath = ({ kind, slug, namespace }: MemoryPageTarget) =>
    `${BASE}/${kind}/${encodeURIComponent(slug)}${namespaceQuery(namespace)}`;

  const linePath = ({ target, factId, action }: { target: MemoryPageTarget; factId: string; action: string }) =>
    `${BASE}/${target.kind}/${encodeURIComponent(target.slug)}/lines/${encodeURIComponent(factId)}/${action}${namespaceQuery(target.namespace)}`;

  return {
    listPages: namespace => request('GET', `${BASE}${namespaceQuery(namespace)}`, undefined, parseData(ListingSchema)),
    getPage: target => request('GET', pagePath(target), undefined, parseData(PageSchema)),
    savePage: ({ text, version, ...target }) =>
      request('PUT', pagePath(target), { text, version }, parseData(PageSchema)),
    confirmLine: ({ factId, section, ...target }) =>
      request(
        'POST',
        linePath({ target, factId, action: 'confirm' }),
        section === undefined ? {} : { section },
        parseData(PageSchema),
      ),
    dismissLine: ({ factId, ...target }) =>
      request('POST', linePath({ target, factId, action: 'dismiss' }), {}, parseData(PageSchema)),
    dismissDisagreement: ({ disagreementId, ...target }) =>
      request(
        'POST',
        `${BASE}/${target.kind}/${encodeURIComponent(target.slug)}/disagreements/${encodeURIComponent(disagreementId)}/dismiss${namespaceQuery(target.namespace)}`,
        {},
        parseData(PageSchema),
      ),
    deletePage: async target => {
      await request('DELETE', pagePath(target), undefined, () => undefined);
    },
  };
}
