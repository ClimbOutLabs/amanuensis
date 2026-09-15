import { z } from '@hono/zod-openapi';
import dedent from 'dedent';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  createDocumentExtractionBudget,
  extractDocumentText,
  MAX_BYTES_PER_DOCUMENT,
  MAX_TOTAL_DOCUMENT_BYTES,
  type DocumentExtraction,
  type DocumentExtractionBudget,
  type DocumentFileProgress,
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
import type { ApprovalDecision } from '../../events/schema';
import { InstructionBuilder } from '../../InstructionBuilder';
import { toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { Sandbox, SandboxDocumentSnapshot } from '../../sandbox/Sandbox';
import type { AgentTracing } from '../../tracing/AgentTracing';
import { throwIfSignalAborted } from '../../util/abort';
import type { AgentCapability } from '../AgentCapability';

export const DOCUMENTS_SERVER_ID = 'documents';
export const EXTRACT_DOCUMENT_TEXT_TOOL_NAME = 'extract_document_text';
export const CREATE_DOCUMENT_REPORT_TOOL_NAME = 'create_document_report';
export const SUMMARIZE_NET_WORTH_TOOL_NAME = 'summarize_net_worth';
export const DOCUMENTS_INSTRUCTION_SECTION = 'documents';

const filePathListSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(32)
  .refine(paths => new Set(paths).size === paths.length, 'Document paths must be unique')
  .describe('Paths from the Uploaded files announcement.');

const filePathsSchema = z.object({ file_paths: filePathListSchema }).strict();

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
    label: z.string().min(1).max(160),
    classification: z.enum(['asset', 'liability']),
    amount_cents: z.number().int().nonnegative().refine(Number.isSafeInteger),
    source: sourceSchema,
  })
  .strict();

const reportRowSchema = z
  .object({
    label: z.string().max(160),
    value: z.string().max(240),
    status: z.enum(['included', 'conflict', 'uncertain', 'info']),
    sources: z.array(z.string().max(240)).max(8),
  })
  .strict();

const reportSectionSchema = z
  .object({ heading: z.string().max(80), rows: z.array(reportRowSchema).max(DOCUMENT_REPORT_MAX_ROWS) })
  .strict()
  .openapi('DocumentReportSection');

const reportSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().max(500),
    sections: z
      .array(reportSectionSchema)
      .max(DOCUMENT_REPORT_MAX_SECTIONS)
      .refine(
        sections => sections.reduce((total, section) => total + section.rows.length, 0) <= DOCUMENT_REPORT_MAX_ROWS,
        {
          message: 'Report exceeds the compact row limit',
        },
      ),
    notes: z.array(z.string().max(500)).max(DOCUMENT_REPORT_MAX_NOTES),
  })
  .strict();

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
      Supported PDF and raster-image attachments are staged in the sandbox, listed in the Uploaded files announcement, and their text is already placed in the message that follows (native PDF text first, local OCR fallback for scanned pages and images), so it does not need to be fetched to be read. Use documents/${EXTRACT_DOCUMENT_TEXT_TOOL_NAME} only to re-extract with page/line-addressable provenance for citation, or when the inline text was truncated or reported unavailable. For a generic report, pass a bounded structured report to documents/${CREATE_DOCUMENT_REPORT_TOOL_NAME}. For the explicit net-worth mode only, cite exact spans from the extraction result in documents/${SUMMARIZE_NET_WORTH_TOOL_NAME}; the host validates those spans and computes totals. Unreadable or unsupported files produce issues, never guesses. Do not use the language model as a PDF/OCR parser or invent missing values.
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
   * budget so existing single-call callers (the `extract_document_text` tool) are unaffected.
   */
  budget: DocumentExtractionBudget = createDocumentExtractionBudget(),
): Promise<DocumentExtraction> {
  const snapshots = new Map<string, SandboxDocumentSnapshot | Error>();
  let remainingSnapshotBytes = MAX_TOTAL_DOCUMENT_BYTES - budget.totalBytes;
  for (const path of file_paths) {
    if (remainingSnapshotBytes < 1) {
      snapshots.set(path, new Error(`Document aggregate byte limit of ${String(MAX_TOTAL_DOCUMENT_BYTES)} exceeded`));
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
        ...(onFileProgress && { onFileProgress }),
        budget,
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
        'Extract page- and line-addressable text from supplied PDF/image attachment paths. Uses native PDF text first and pinned local OCR as fallback. Returns per-file issues and SHA-256 source provenance; never infers unreadable content.',
      schema: filePathsSchema,
      handler: input => this.extractText(input.file_paths),
    }),
    defineTool({
      name: CREATE_DOCUMENT_REPORT_TOOL_NAME,
      description:
        'Render a compact bounded structured document report as a downloadable DOCX artifact suitable for concise summaries. This renderer does not interpret document contents or calculate totals and does not promise a page count.',
      schema: reportSchema,
      handler: (input, approvalDecision) => this.createReport(input, approvalDecision),
    }),
    defineTool({
      name: SUMMARIZE_NET_WORTH_TOOL_NAME,
      description:
        'Explicit net-worth report mode: extract supplied files, validate each cited exact source span, preserve conflicts and uncertain claims, compute asset/liability totals deterministically, and render a downloadable DOCX.',
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

  private async extractText(file_paths: readonly string[]) {
    try {
      return toolResultResponse({ text: JSON.stringify(await extractDocumentsFromSandbox(this.sandbox, file_paths)) });
    } catch (error) {
      return toolResultResponse({
        text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        isError: true,
      });
    }
  }

  private async createReport(report: StructuredDocumentReport, approvalDecision?: ApprovalDecision) {
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({ name: CREATE_DOCUMENT_REPORT_TOOL_NAME, arguments: { ...report } }),
        },
      };
    }
    try {
      const content = await createStructuredDocumentDocx(report);
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
      const extraction = await extractDocumentsFromSandbox(this.sandbox, file_paths);
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
  };
}
