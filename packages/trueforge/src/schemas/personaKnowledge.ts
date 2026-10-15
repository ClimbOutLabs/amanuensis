import { z } from '@hono/zod-openapi';

export const KnowledgeDocumentStatusSchema = z
  .enum(['pending', 'parsing', 'indexing', 'ready', 'failed'])
  .describe('Where the document is in the background indexing pipeline.')
  .openapi('KnowledgeDocumentStatus');

export const KnowledgeSourceKindSchema = z
  .enum(['upload', 'url', 'text'])
  .describe('How the document entered the library: file upload, saved link, or pasted text.')
  .openapi('KnowledgeSourceKind');

export type KnowledgeDocumentStatus = z.infer<typeof KnowledgeDocumentStatusSchema>;
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKindSchema>;

/**
 * True only for http(s) URLs without embedded credentials. The fetch layer
 * re-checks this before any request; the schema rejects early so dangerous
 * schemes (javascript:, data:) and userinfo can never be persisted or
 * rendered as a clickable href.
 */
export function isFetchableHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === ''
  );
}

export const PersonaKnowledgeDocumentSchema = z
  .object({
    id: z.string().min(1).describe('Stable knowledge document identifier.'),
    title: z.string().min(1).max(256).describe('Title shown in the library and cited in answers.'),
    title_explicit: z
      .boolean()
      .describe('True when the user supplied the title; false when it was defaulted from the source.'),
    source_kind: KnowledgeSourceKindSchema,
    source_label: z.string().min(1).max(512).describe('Human-readable origin: file name, link text, or "Pasted text".'),
    source_url: z.url().max(2048).nullable().describe('Final link address, for saved links.'),
    status: KnowledgeDocumentStatusSchema,
    status_message: z
      .string()
      .max(1024)
      .nullable()
      .describe('Plain-English explanation when the document is paused or failed.'),
    chunk_count: z.number().int().min(0).describe('Searchable chunks once the document is ready.'),
    created_at: z.iso.datetime().describe('When the document was added (ISO 8601).'),
    updated_at: z.iso.datetime().describe('Last status change (ISO 8601).'),
  })
  .openapi('PersonaKnowledgeDocument');

export const ListKnowledgeDocumentsResponseSchema = z
  .object({ data: z.array(PersonaKnowledgeDocumentSchema) })
  .openapi('ListKnowledgeDocumentsResponse');

export const GetKnowledgeDocumentResponseSchema = z
  .object({ data: PersonaKnowledgeDocumentSchema })
  .openapi('GetKnowledgeDocumentResponse');

export const DeleteKnowledgeDocumentResponseSchema = z.object({}).openapi('DeleteKnowledgeDocumentResponse');

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const KnowledgeDocumentUploadRequestSchema = z
  .object({
    kind: z.literal('upload'),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe('Original file name, used to detect PDF, Word, text, or Markdown.'),
    content_base64: z
      .string()
      .min(1)
      .max(20_971_520)
      .refine(value => BASE64_PATTERN.test(value.replace(/\s+/g, '')), 'content_base64 must be valid base64.')
      .describe('File bytes as base64 (max 15 MB decoded).'),
    title: z.string().trim().min(1).max(256).optional().describe('Shown instead of the file name.'),
  })
  .openapi('KnowledgeDocumentUploadRequest');

const KnowledgeDocumentUrlRequestSchema = z
  .object({
    kind: z.literal('url'),
    url: z
      .url()
      .trim()
      .max(2048)
      // z.url() accepts any scheme (including javascript:) and userinfo; only
      // http(s) links can be fetched, and credentials must never be persisted
      // or rendered as a clickable href (stored XSS via the library list).
      .refine(isFetchableHttpUrl, 'Only http and https links can be saved.')
      .describe('Public web page or PDF link; the page text is snapshotted at save time.'),
    title: z.string().trim().min(1).max(256).optional().describe('Shown instead of the page title.'),
  })
  .openapi('KnowledgeDocumentUrlRequest');

const KnowledgeDocumentTextRequestSchema = z
  .object({
    kind: z.literal('text'),
    title: z.string().trim().min(1).max(256).describe('Title for the pasted text.'),
    text: z.string().min(1).max(1_000_000).describe('Text pasted directly into the library.'),
  })
  .openapi('KnowledgeDocumentTextRequest');

export const CreateKnowledgeDocumentRequestSchema = z
  .discriminatedUnion('kind', [
    KnowledgeDocumentUploadRequestSchema,
    KnowledgeDocumentUrlRequestSchema,
    KnowledgeDocumentTextRequestSchema,
  ])
  .openapi('CreateKnowledgeDocumentRequest');

export const KnowledgeEmbeddingPhaseSchema = z
  .enum(['idle', 'loading', 'downloading', 'ready', 'unavailable'])
  .describe('State of the one-time search model download.')
  .openapi('KnowledgeEmbeddingPhase');

export const KnowledgeEmbeddingModelSchema = z
  .object({
    phase: KnowledgeEmbeddingPhaseSchema,
    message: z.string().max(1024).describe('Plain-English explanation of the current state.'),
  })
  .openapi('KnowledgeEmbeddingModel');

export const GetKnowledgeEmbeddingModelResponseSchema = z
  .object({ data: KnowledgeEmbeddingModelSchema })
  .openapi('GetKnowledgeEmbeddingModelResponse');

export type PersonaKnowledgeDocument = z.infer<typeof PersonaKnowledgeDocumentSchema>;
export type CreateKnowledgeDocumentRequest = z.infer<typeof CreateKnowledgeDocumentRequestSchema>;
