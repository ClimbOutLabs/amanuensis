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
  })
  .transform(page => ({
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    otherNames: page.other_names,
    summary: page.summary,
    changedOn: page.changed_on,
    unconfirmedCount: page.unconfirmed_count,
  }));

const PageLineSchema = z
  .object({
    id: z.string().nullable(),
    text: z.string(),
    source: z.string(),
    source_label: z.string(),
    own: z.boolean(),
    since: z.string().nullable(),
    until: z.string().nullable(),
    seen: z.string().nullable(),
  })
  .transform(line => ({
    id: line.id,
    text: line.text,
    source: line.source,
    sourceLabel: line.source_label,
    own: line.own,
    since: line.since,
    until: line.until,
    seen: line.seen,
  }));

const PageSchema = z
  .object({
    kind: PageKindSchema,
    slug: z.string(),
    title: z.string(),
    other_names: z.array(z.string()),
    summary: z.string().nullable(),
    sections: z.array(z.object({ name: z.string(), lines: z.array(PageLineSchema) })),
    markdown: z.string(),
    confirmable_sections: z.array(z.string()),
    version: z.string(),
  })
  .transform(page => ({
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    otherNames: page.other_names,
    summary: page.summary,
    sections: page.sections,
    markdown: page.markdown,
    confirmableSections: page.confirmable_sections,
    version: page.version,
  }));

const ChangesSchema = z
  .object({
    available: z.boolean(),
    changes: z.array(
      z.object({
        id: z.string(),
        changed_at: z.string(),
        message: z.string(),
        pages: z.array(z.object({ kind: PageKindSchema, slug: z.string() })),
        undo_blocked_by: z.string().nullable(),
      }),
    ),
  })
  .transform(result => ({
    available: result.available,
    changes: result.changes.map(change => ({
      id: change.id,
      changedAt: change.changed_at,
      message: change.message,
      pages: change.pages,
      undoBlockedBy: change.undo_blocked_by,
    })),
  }));

const ListingSchema = z
  .object({ pages: z.array(PageSummarySchema), skipped_files: z.array(z.string()) })
  .transform(listing => ({ pages: listing.pages, skippedFiles: listing.skipped_files }));

export type MemoryPageSummary = z.output<typeof PageSummarySchema>;
export type MemoryPageLine = z.output<typeof PageLineSchema>;
export type MemoryPageDetail = z.output<typeof PageSchema>;
export type MemoryPageChanges = z.output<typeof ChangesSchema>;
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
  savePage(options: MemoryPageTarget & { markdown: string; version: string }): Promise<MemoryPageDetail>;
  confirmLine(options: MemoryPageTarget & { factId: string; section?: string | undefined }): Promise<MemoryPageDetail>;
  dismissLine(options: MemoryPageTarget & { factId: string }): Promise<MemoryPageDetail>;
  deletePage(target: MemoryPageTarget): Promise<void>;
  listChanges(namespace?: string): Promise<MemoryPageChanges>;
  undoChange(options: { changeId: string; namespace?: string | undefined }): Promise<void>;
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
    savePage: ({ markdown, version, ...target }) =>
      request('PUT', pagePath(target), { markdown, version }, parseData(PageSchema)),
    confirmLine: ({ factId, section, ...target }) =>
      request(
        'POST',
        linePath({ target, factId, action: 'confirm' }),
        section === undefined ? {} : { section },
        parseData(PageSchema),
      ),
    dismissLine: ({ factId, ...target }) =>
      request('POST', linePath({ target, factId, action: 'dismiss' }), {}, parseData(PageSchema)),
    deletePage: async target => {
      await request('DELETE', pagePath(target), undefined, () => undefined);
    },
    listChanges: namespace =>
      request('GET', `${BASE}/changes${namespaceQuery(namespace)}`, undefined, parseData(ChangesSchema)),
    undoChange: async ({ changeId, namespace }) => {
      await request('POST', `${BASE}/changes/${changeId}/undo${namespaceQuery(namespace)}`, {}, () => undefined);
    },
  };
}
