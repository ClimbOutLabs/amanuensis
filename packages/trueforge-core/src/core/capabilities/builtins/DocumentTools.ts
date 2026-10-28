import { z } from '@hono/zod-openapi';
import dedent from 'dedent';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  createDocumentExtractionBudget,
  createSessionDocumentExtractionBudget,
  extractDocumentText,
  MAX_BYTES_PER_DOCUMENT,
  MAX_PAGES_PER_DOCUMENT,
  type DocumentExtraction,
  type DocumentExtractionBudget,
  type DocumentFileProgress,
  type DocumentPageRange,
} from '../../../documents/documentExtraction';
import {
  createStructuredDocumentDocx,
  DOCUMENT_REPORT_MAX_NOTE_LENGTH,
  DOCUMENT_REPORT_MAX_NOTES,
  DOCUMENT_REPORT_MAX_ROWS,
  DOCUMENT_REPORT_MAX_SECTIONS,
  DOCUMENT_REPORT_MAX_SOURCE_LENGTH,
  type StructuredDocumentReport,
} from '../../../documents/documentRenderer';
import {
  netWorthAsDocumentReport,
  summarizeNetWorth,
  type NetWorthObservationInput,
} from '../../../documents/netWorthReport';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../documents/toolContract';
import type { ApprovalDecision } from '../../events/schema';
import { InstructionBuilder } from '../../InstructionBuilder';
import { toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { ToolBundleName } from '../../runtime/toolBundleCatalog';
import type { Sandbox, SandboxDocumentSnapshot } from '../../sandbox/Sandbox';
import type { AgentTracing } from '../../tracing/AgentTracing';
import { throwIfSignalAborted } from '../../util/abort';
import type { AgentCapability } from '../AgentCapability';

export const DOCUMENTS_SERVER_ID = 'documents';
export const CREATE_DOCUMENT_REPORT_TOOL_NAME = 'create_document_report';
export const SUMMARIZE_NET_WORTH_TOOL_NAME = 'summarize_net_worth';
export const DOCUMENTS_INSTRUCTION_SECTION = 'documents';

const filePathListSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(32)
  .refine(paths => new Set(paths).size === paths.length, 'Document paths must be unique')
  .describe(
    'Paths from the Uploaded files announcement, or the staged path of a file placed in the sandbox, such as a path given in an attachment note in a tool result.',
  );

/**
 * Page-range schema for extract_document_text. Both ends are optional:
 * page_start alone reads a full window from that page; page_end alone reads
 * from page 1. The resolved width never exceeds MAX_PAGES_PER_DOCUMENT, and
 * native PDF extraction starts at page_start instead of re-scanning from
 * page 1.
 */
const extractDocumentTextSchema = z
  .object({
    file_paths: filePathListSchema,
    page_start: z.number().int().positive().optional().describe('First PDF page to read (1-based). Defaults to 1.'),
    page_end: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Last PDF page to read (inclusive). Defaults to a full window past page_start.'),
  })
  .strict()
  .refine(data => data.page_end === undefined || data.page_start === undefined || data.page_end >= data.page_start, {
    message: 'page_end must be >= page_start',
  })
  .refine(
    data => {
      const start = data.page_start ?? 1;
      const end = data.page_end ?? start + MAX_PAGES_PER_DOCUMENT - 1;
      return end - start + 1 <= MAX_PAGES_PER_DOCUMENT;
    },
    { message: `page range width must be <= ${String(MAX_PAGES_PER_DOCUMENT)} pages` },
  );

type ExtractDocumentTextInput = z.infer<typeof extractDocumentTextSchema>;

/** Resolves omitted range ends to a concrete inclusive range. */
function resolvePageRange(input: ExtractDocumentTextInput): DocumentPageRange | undefined {
  if (input.page_start === undefined && input.page_end === undefined) {
    return undefined;
  }
  const page_start = input.page_start ?? 1;
  const page_end = input.page_end ?? page_start + MAX_PAGES_PER_DOCUMENT - 1;
  return { page_start, page_end };
}

const sourceSchema = z
  .object({
    filename: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().length(64),
    page: z.number().int().positive(),
    line: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    span_text: z.string(),
    extraction_mode: z.enum(['text', 'ocr']),
  })
  .strict();

const netWorthObservationSchema = z
  .object({
    key: z.string().min(1).max(120),
    label: z
      .string()
      .min(1)
      .refine(v => v.length <= 160, 'must be at most 160 characters'),
    classification: z.enum(['asset', 'liability']),
    amount_cents: z.number().int().nonnegative().refine(Number.isSafeInteger),
    source: sourceSchema,
  })
  .strict();

const reportRowSchema = z
  .object({
    label: z.string().refine(v => v.length <= 160, 'must be at most 160 characters'),
    value: z.string().refine(v => v.length <= 240, 'must be at most 240 characters'),
    status: z.enum(['included', 'conflict', 'uncertain', 'info']),
    sources: z.array(z.string().refine(v => v.length <= 240, 'must be at most 240 characters')).max(8),
  })
  .strict();

const reportSectionSchema = z
  .object({ heading: z.string().max(80), rows: z.array(reportRowSchema) })
  .strict()
  .openapi('DocumentReportSection');

const reportSchema = z
  .object({
    mode: z
      .enum(['compact', 'full'])
      .default('compact')
      .describe('compact (default) is capped as described above; full has no cap, for long reports.'),
    title: z.string().trim().min(1).max(120),
    summary: z.string().refine(v => v.length <= 500, 'must be at most 500 characters'),
    sections: z.array(reportSectionSchema),
    notes: z.array(z.string().refine(v => v.length <= 500, 'must be at most 500 characters')),
  })
  .strict();

type ReportToolInput = z.infer<typeof reportSchema>;

const netWorthSchema = z
  .object({
    file_paths: filePathListSchema,
    observations: z.array(netWorthObservationSchema).max(64),
    title: z.string().trim().min(1).max(120).default('Net Worth Summary'),
  })
  .strict();

function truncateForReport(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maximumLength - 3))}...`;
}

function compactNetWorthDocumentReport(report: StructuredDocumentReport): StructuredDocumentReport {
  let remainingRows = DOCUMENT_REPORT_MAX_ROWS;
  const sections = report.sections.slice(0, DOCUMENT_REPORT_MAX_SECTIONS).map(section => {
    const rows = section.rows.slice(0, remainingRows).map(row => ({
      ...row,
      label: truncateForReport(row.label, 160),
      value: truncateForReport(row.value, 240),
      sources: [...new Set(row.sources)]
        .slice(0, 8)
        .map(source => truncateForReport(source, DOCUMENT_REPORT_MAX_SOURCE_LENGTH)),
    }));
    remainingRows -= rows.length;
    return { ...section, heading: truncateForReport(section.heading, 80), rows };
  });

  const renderedRowCount = DOCUMENT_REPORT_MAX_ROWS - remainingRows;
  const totalRowCount = report.sections.reduce((total, section) => total + section.rows.length, 0);
  const omittedRowCount = totalRowCount - renderedRowCount;
  const notes = report.notes
    .slice(0, DOCUMENT_REPORT_MAX_NOTES)
    .map(note => truncateForReport(note, DOCUMENT_REPORT_MAX_NOTE_LENGTH));
  if (omittedRowCount > 0) {
    const overflowNote = `${String(omittedRowCount)} additional observations remain in the structured audit data.`;
    if (notes.length === DOCUMENT_REPORT_MAX_NOTES) {
      notes[notes.length - 1] = overflowNote;
    } else {
      notes.push(overflowNote);
    }
  }

  return {
    ...report,
    sections,
    notes,
  };
}

export function buildDocumentsInstruction(builder: InstructionBuilder): void {
  builder.addSection(
    DOCUMENTS_INSTRUCTION_SECTION,
    dedent`
      Supported PDF and raster-image attachments are staged in the sandbox, listed in the Uploaded files announcement, and their text is already placed in the message that follows (native PDF text first, local OCR fallback for scanned pages and images), so it does not need to be fetched to be read. Use documents/${EXTRACT_DOCUMENT_TEXT_TOOL_NAME} only to re-extract with page/line-addressable provenance for citation, or when the inline text was truncated or reported unavailable. A PDF staged from an email or chat attachment is read with documents/${EXTRACT_DOCUMENT_TEXT_TOOL_NAME} using its staged path, the same as an announced upload. For a generic report, pass a structured report to documents/${CREATE_DOCUMENT_REPORT_TOOL_NAME}: compact mode (default) is a bounded digest of ${String(DOCUMENT_REPORT_MAX_SECTIONS)} sections, ${String(DOCUMENT_REPORT_MAX_ROWS)} rows, ${String(DOCUMENT_REPORT_MAX_NOTES)} notes, while full mode renders a multi-page report with no row or section cap for long reports such as financial plans. For the explicit net-worth mode only, cite exact spans from the extraction result in documents/${SUMMARIZE_NET_WORTH_TOOL_NAME}; the host validates those spans and computes totals. Unreadable or unsupported files produce issues, never guesses. Do not use the language model as a PDF/OCR parser or invent missing values.
    `.trim(),
  );
}

/**
 * Downloads a bounded, verified snapshot of each staged path and extracts its text through the
 * sandbox's native-PDF-text and OCR adapters. Shared by the `extract_document_text` tool and by
 * upload-time ingestion at the chokepoint (see `processAgentUserInput`) so both paths run the same
 * sandbox shell commands rather than duplicating them.
 */
export async function extractDocumentsFromSandbox(
  sandbox: Sandbox,
  file_paths: readonly string[],
  signal?: AbortSignal,
  onFileProgress?: (progress: DocumentFileProgress) => void,
  /**
   * Threaded across a sequence of single/few-file calls (see `AgentThread.extractStagedDocuments`)
   * so the aggregate byte/page/character/file-count caps hold across the whole upload even though
   * each file is extracted, and its progress event yielded, one at a time. Defaults to a fresh
   * per-call budget; the `extract_document_text` tool passes its session budget instead.
   */
  budget: DocumentExtractionBudget = createDocumentExtractionBudget(),
  /**
   * Page range for PDF extraction. The tool path resolves this from the
   * page_start/page_end arguments; upload-time ingestion passes none.
   */
  pageRange?: DocumentPageRange,
): Promise<DocumentExtraction> {
  const snapshots = new Map<string, SandboxDocumentSnapshot | Error>();
  let remainingSnapshotBytes = budget.maxTotalBytes - budget.totalBytes;
  for (const path of file_paths) {
    if (remainingSnapshotBytes < 1) {
      snapshots.set(path, new Error(`Document aggregate byte limit of ${String(budget.maxTotalBytes)} exceeded`));
      continue;
    }
    try {
      throwIfSignalAborted(signal);
      const snapshot = await sandbox.createDocumentSnapshot({
        filePath: path,
        maxBytes: Math.min(MAX_BYTES_PER_DOCUMENT, remainingSnapshotBytes),
        signal,
      });
      remainingSnapshotBytes -= snapshot.content.length;
      snapshots.set(path, snapshot);
    } catch (error) {
      snapshots.set(path, error instanceof Error ? error : new Error(String(error), { cause: error }));
    }
  }
  const snapshotFor = (path: string): SandboxDocumentSnapshot => {
    const record = snapshots.get(path);
    if (record === undefined) {
      throw new Error(`No document snapshot exists for ${path}`);
    }
    if (record instanceof Error) {
      throw record;
    }
    return record;
  };
  const operation = await (async () => {
    try {
      throwIfSignalAborted(signal);
      const extraction = await extractDocumentText({
        files: file_paths.map(path => ({ filename: basename(path), path })),
        downloadFile: path => Promise.resolve(snapshotFor(path).content),
        runOcr: input => {
          throwIfSignalAborted(signal);
          return sandbox.runDocumentOcr({ ...input, filePath: snapshotFor(input.filePath).filePath, signal });
        },
        runNativePdfText: input => {
          throwIfSignalAborted(signal);
          return sandbox.runDocumentText({ ...input, filePath: snapshotFor(input.filePath).filePath, signal });
        },
        onFileProgress,
        budget,
        pageRange,
      });
      await Promise.all(
        [...snapshots.values()]
          .filter((record): record is SandboxDocumentSnapshot => !(record instanceof Error))
          .map(snapshot => snapshot.verify()),
      );
      return { ok: true as const, extraction };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  const cleanup = await Promise.allSettled(
    [...snapshots.values()]
      .filter((record): record is SandboxDocumentSnapshot => !(record instanceof Error))
      .map(snapshot => snapshot.cleanup()),
  );
  if (!operation.ok) {
    throw operation.error;
  }
  const cleanupFailure = cleanup.find(result => result.status === 'rejected');
  if (cleanupFailure?.status === 'rejected') {
    throw cleanupFailure.reason;
  }
  return operation.extraction;
}

export class DocumentTools extends LocalToolMCP {
  readonly name = DOCUMENTS_SERVER_ID;
  readonly displayName = 'Documents';
  protected override readonly bundle: ToolBundleName = 'documents';

  // The net-worth mode is asked for by name, so it rides with the other on-request tools.
  override bundleOf(toolName: string): ToolBundleName {
    return toolName === SUMMARIZE_NET_WORTH_TOOL_NAME ? 'extras' : this.bundle;
  }

  /**
   * Session-scale extraction budget: repeated extract_document_text calls
   * (e.g. paging through a long PDF range by range) share one aggregate
   * ceiling instead of each getting a fresh per-call budget. Not a cache:
   * every call re-extracts from the sandbox snapshot.
   */
  private readonly sessionBudget: DocumentExtractionBudget = createSessionDocumentExtractionBudget();

  constructor(
    private readonly sandbox: Sandbox,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      description:
        'Extract page- and line-addressable text from PDF/image attachments. Native PDF text first, local OCR fallback. Returns per-file issues and SHA-256 provenance; never infers unreadable content. For long PDFs, page with page_start/page_end; each result names the exact next range.',
      schema: extractDocumentTextSchema,
      handler: input => this.extractText(input),
    }),
    defineTool({
      name: CREATE_DOCUMENT_REPORT_TOOL_NAME,
      description:
        `Render a downloadable DOCX report; it does not interpret contents or calculate totals. ` +
        `compact (default) caps at ${String(DOCUMENT_REPORT_MAX_SECTIONS)} sections, ` +
        `${String(DOCUMENT_REPORT_MAX_ROWS)} rows and ${String(DOCUMENT_REPORT_MAX_NOTES)} notes. ` +
        'full has no cap.',
      schema: reportSchema,
      handler: (input, approvalDecision) => this.createReport(input, approvalDecision),
    }),
    defineTool({
      name: SUMMARIZE_NET_WORTH_TOOL_NAME,
      description:
        'Net-worth DOCX from supplied files: checks each cited source span, keeps conflicts and uncertain claims, and computes asset and liability totals deterministically.',
      schema: netWorthSchema,
      handler: (input, approvalDecision) =>
        this.createNetWorthReport(input.file_paths, input.observations, input.title, approvalDecision),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  override async toolCallInfo(params: Parameters<LocalToolMCP['toolCallInfo']>[0], resolveUnderlyingTool?: boolean) {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    const createsArtifact =
      params.name === CREATE_DOCUMENT_REPORT_TOOL_NAME || params.name === SUMMARIZE_NET_WORTH_TOOL_NAME;
    return {
      ...info,
      effect: createsArtifact ? ('edit' as const) : ('inspect' as const),
      read_only_hint: !createsArtifact,
      destructive_hint: false,
      open_world_hint: false,
      is_approval_required: createsArtifact,
    };
  }

  private async extractText(input: ExtractDocumentTextInput) {
    try {
      return toolResultResponse({
        text: JSON.stringify(
          await extractDocumentsFromSandbox(
            this.sandbox,
            input.file_paths,
            undefined,
            undefined,
            this.sessionBudget,
            resolvePageRange(input),
          ),
        ),
      });
    } catch (error) {
      return toolResultResponse({
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        isError: true,
      });
    }
  }

  private async createReport(input: ReportToolInput, approvalDecision?: ApprovalDecision) {
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: { ...input } }),
        },
      };
    }
    try {
      const { mode, ...report } = input;
      const content = await createStructuredDocumentDocx(report, { mode });
      return await this.storeArtifact(content, { report });
    } catch (error) {
      return toolResultResponse({
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        isError: true,
      });
    }
  }

  private async createNetWorthReport(
    file_paths: readonly string[],
    observations: readonly NetWorthObservationInput[],
    title: string,
    approvalDecision?: ApprovalDecision,
  ) {
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({
            name: SUMMARIZE_NET_WORTH_TOOL_NAME,
            arguments: { file_paths, observations, title },
          }),
        },
      };
    }
    try {
      const extraction = await extractDocumentsFromSandbox(
        this.sandbox,
        file_paths,
        undefined,
        undefined,
        this.sessionBudget,
      );
      const report = summarizeNetWorth(extraction, observations);
      const documentReport = compactNetWorthDocumentReport(netWorthAsDocumentReport(report, title));
      const content = await createStructuredDocumentDocx(documentReport);
      return await this.storeArtifact(content, { report });
    } catch (error) {
      return toolResultResponse({
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        isError: true,
      });
    }
  }

  private async storeArtifact(content: Buffer, payload: { report: unknown }) {
    const stored = await this.sandbox.writeArtifact({ fileName: `document-report-${randomUUID()}.docx`, content });
    return toolResultResponse({
      text: JSON.stringify({ ...payload, artifact_path: stored.filePath }),
      overrides: {
        sandboxCreated: stored.sandboxCreated !== undefined,
        ...(stored.sandboxCreated !== undefined && { sandboxInfo: stored.sandboxCreated }),
      },
    });
  }
}

export function documentCapability(options: { sandbox: Sandbox; tracing: AgentTracing }): AgentCapability {
  return {
    systemToolSets: [new DocumentTools(options.sandbox, options.tracing)],
    instructionBuilders: [buildDocumentsInstruction],
    bundle: 'documents',
  };
}
