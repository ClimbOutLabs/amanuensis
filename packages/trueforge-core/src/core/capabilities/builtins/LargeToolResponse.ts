import dedent from 'dedent';
import type { Logger } from 'winston';
import { estimateTokensForString } from '../../llm/usage';
import type { ToolCallResult } from '../../mcp/executeToolCalls';
import type { ContextMessage } from '../../runtime/AgentThread.types';
import type { Sandbox, SandboxInfo } from '../../sandbox/Sandbox';
import { createSandboxLargeToolResponseGuidance, SANDBOX_SCHEMA_INFER_TAG } from '../../sandbox/Sandbox';
import { TAVILY_EXTRACT_TOOL_NAME } from '../../search/TavilyClient';
import type { AgentTracing } from '../../tracing/AgentTracing';
import { extractErrorLogFields } from '../../util/errorLogFields';
import type { AgentCapability } from '../AgentCapability';
import type { AgentThreadExecutionContext } from '../AgentContextProcessor';
import type { ToolResponseProcessor, ToolResponseProcessorResult } from '../ToolResponseProcessor';
import { createDynamicSubAgentLargeToolResponseGuidance } from './DynamicSubAgents';
import {
  emailFetchGuidance,
  emailFetchSemanticsFor,
  summarizeEmailResult,
  summarizeEmailTextResult,
} from './EmailFetchSemantics';
import {
  looksLikeJsonObjectOrArray,
  OVERSIZED_RESULT_PARSE_MAX_BYTES,
  oversizedResultFingerprint,
  renderOversizedResultSummary,
  summarizeGenericTextResult,
  summarizeOversizedResult,
  type OversizedResultSummary,
} from './OversizedResult';

export const DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD = 6000;
export const DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD = 10000;
export const DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS = 100;
export const SANDBOX_LARGE_OUTPUT_HEAD_CHARS = 6_000;
const FAILURE_MESSAGE_TRUNCATION_LENGTH = 500;

type ResultCategory = 'failure' | 'sandbox' | 'mcp';

interface ToolResultWithInfo {
  toolCallResult: ToolCallResult;
  originalContent: string;
  originalTokens: number;
  category: ResultCategory;
}

function categorize(result: ToolCallResult, sandbox: Sandbox | undefined): ResultCategory {
  if (result.failure) {
    return 'failure';
  }
  if (!result.info) {
    throw new Error(`Unreachable`);
  }
  if (sandbox && result.info.toolSet === sandbox) {
    return 'sandbox';
  }
  return 'mcp';
}

function createContentPreview(content: string, previewChars: number): string {
  if (content.length <= previewChars * 2) {
    return content;
  }
  return `${content.slice(0, previewChars)}\n...\n${content.slice(-previewChars)}`;
}

function createBoundedHead(content: string, headChars: number): { head: string; charCount: number } {
  const originalCharCount = content.length;
  let head = content.slice(0, headChars);

  if (head.length < originalCharCount) {
    const lastNewlineIndex = head.lastIndexOf('\n');
    if (lastNewlineIndex > 0) {
      head = head.slice(0, lastNewlineIndex);
    }
  }

  return { head, charCount: originalCharCount };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JSON_STRUCTURAL_SUMMARY_MAX_LINES = 60;
const JSON_STRUCTURAL_SUMMARY_MAX_ITEMS = 2;
// Bounds a single line (e.g. a long top-level-keys join, or one line of a serialized sample
// item) so a single oversized value cannot itself defeat the large-output guard.
const JSON_STRUCTURAL_SUMMARY_MAX_LINE_CHARS = 200;
// Bounds the summary as a whole. The 60-line cap alone does not bound total size: a single
// sampled item can serialize to arbitrarily many lines before the line count is checked, so this
// keeps the summary substantially below the large-tool-response token threshold even then.
const JSON_STRUCTURAL_SUMMARY_MAX_TOTAL_CHARS = 4000;

function truncateSummaryLine(line: string): string {
  return line.length > JSON_STRUCTURAL_SUMMARY_MAX_LINE_CHARS
    ? `${line.slice(0, JSON_STRUCTURAL_SUMMARY_MAX_LINE_CHARS)}... (value truncated)`
    : line;
}

/**
 * Build the lines of a compact structural summary for a large JSON tool
 * result: top-level keys, the length of every top-level array, and the first
 * couple of items of the largest one, so the model can decide how to page
 * the stored result without reading it blind. Returns an empty array for a
 * non-object, non-array root (there is no structure worth summarizing).
 */
function summarizeJsonStructureLines(parsed: unknown): string[] {
  const lines: string[] = [];
  let largest: { label: string; items: unknown[] } | undefined;

  if (Array.isArray(parsed)) {
    lines.push(`Top-level: array, length ${String(parsed.length)}`);
    largest = { label: '(root array)', items: parsed };
  } else if (isRecord(parsed)) {
    const keys = Object.keys(parsed);
    lines.push(truncateSummaryLine(`Top-level keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`));
    for (const key of keys) {
      const value = parsed[key];
      if (!Array.isArray(value)) {
        continue;
      }
      lines.push(truncateSummaryLine(`  ${key}: array, length ${String(value.length)}`));
      if (largest === undefined || value.length > largest.items.length) {
        largest = { label: key, items: value };
      }
    }
  } else {
    return [];
  }

  if (largest !== undefined && largest.items.length > 0) {
    const shown = largest.items.slice(0, JSON_STRUCTURAL_SUMMARY_MAX_ITEMS);
    lines.push(`First ${String(shown.length)} item(s) of ${largest.label}:`);
    for (const item of shown) {
      lines.push(...JSON.stringify(item, null, 2).split('\n').map(truncateSummaryLine));
    }
  }

  const bounded =
    lines.length > JSON_STRUCTURAL_SUMMARY_MAX_LINES
      ? [...lines.slice(0, JSON_STRUCTURAL_SUMMARY_MAX_LINES - 1), '... (structure summary truncated)']
      : lines;

  let total = 0;
  for (let i = 0; i < bounded.length; i += 1) {
    const line = bounded[i] ?? '';
    // +1 accounts for the newline that will join this line to the next.
    total += line.length + 1;
    if (total > JSON_STRUCTURAL_SUMMARY_MAX_TOTAL_CHARS) {
      return [...bounded.slice(0, i), '... (structure summary truncated)'];
    }
  }
  return bounded;
}

/** Structural summary text for a large JSON result, or `undefined` when `content` is not JSON. */
export function jsonStructuralSummary(content: string): string | undefined {
  // Security: never parse unbounded content in the panic path. A malicious
  // or buggy MCP server can return a 100MB+ blob; parsing it here would OOM
  // the host. The 1 MiB ceiling matches the summarizer's parse budget.
  if (Buffer.byteLength(content, 'utf8') > OVERSIZED_RESULT_PARSE_MAX_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const lines = summarizeJsonStructureLines(parsed);
  return lines.length === 0 ? undefined : lines.join('\n');
}

function sandboxRawOutputStorageGuidance(content: string): string {
  // Security: same bound as jsonStructuralSummary — do not parse unbounded
  // content looking for a storage_status field.
  let parsed: unknown;
  try {
    parsed = Buffer.byteLength(content, 'utf8') > OVERSIZED_RESULT_PARSE_MAX_BYTES ? undefined : JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  const rawOutput = isRecord(parsed) && isRecord(parsed['raw_output']) ? parsed['raw_output'] : undefined;
  const storageStatus = rawOutput?.['storage_status'];
  if (storageStatus === 'stored') {
    return 'Raw output storage: raw_output.storage_status=stored; the complete output is available in the durable raw_output artifact named in the result.';
  }
  if (storageStatus === 'failed') {
    return 'Raw output storage: raw_output.storage_status=failed; durable storage failed, so the complete output is not available from a raw_output artifact.';
  }
  return 'Raw output storage: raw_output.storage_status=unavailable; this unbounded result has no durable raw_output artifact.';
}

/**
 * Ingestion budgets. Each one bounds what a tool result contributes to the history the model
 * resends on every later step. The full result is never changed upstream: grounding records fetched
 * page text in ToolSet before this pass runs. Space bodies are not budgeted: a shortened body could be
 * written back over the whole space by update_space.
 */
export const PAGE_READ_TOKEN_BUDGET = 2_500;
export const SANDBOX_OUTPUT_EDGE_LINES = 40;

const EXEC_OUTPUT_HINT =
  'To see other lines, call exec again with output.head_lines, output.tail_lines or output.grep.';
const RUN_CODE_OUTPUT_HINT = 'The other lines are not available from this result.';

/** Words of at least four letters or digits, lowercased: the terms a page section may be kept for. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
}

function userMessageText(message: ContextMessage): string | undefined {
  if (!('role' in message) || message.role !== 'user') {
    return undefined;
  }
  const { content } = message;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.map(part => (part.type === 'text' ? part.text : '')).join(' ');
}

/** The words of the latest user message: the request a fetched page section is kept for. */
function requestWordsOf(context: readonly ContextMessage[]): Set<string> {
  for (const message of [...context].reverse()) {
    const text = userMessageText(message);
    if (text !== undefined) {
      return new Set(wordsOf(text));
    }
  }
  return new Set();
}

function mentionsRequest(block: string, request: ReadonlySet<string>): boolean {
  return wordsOf(block).some(word => request.has(word));
}

/** Cuts text to about maxTokens. estimateTokensForString counts four characters per token. */
function cutToTokens(text: string, maxTokens: number): string {
  return text.slice(0, Math.floor(maxTokens * 4));
}

/**
 * Keeps the opening block, then each heading with its first paragraph, and any paragraph that mentions a
 * word from the request, in page order, until the token budget is spent. The opening block is always kept,
 * cut to the budget if it alone is larger, so a page never comes back as only its note.
 */
export function budgetPageText(input: { text: string; request: ReadonlySet<string>; maxTokens: number }): string {
  const { text, request, maxTokens } = input;
  const totalTokens = estimateTokensForString(text);
  if (totalTokens <= maxTokens) {
    return text;
  }
  const blocks = text.split(/\n{2,}/);
  // A group is one block to keep whole: a heading with its first paragraph, or one paragraph.
  const structural: number[][] = [];
  const requested: number[][] = [];
  let openHeading: number[] | undefined;
  blocks.forEach((block, index) => {
    if (/^#{1,6}\s/.test(block.trim())) {
      openHeading = [index];
      structural.push(openHeading);
      return;
    }
    if (openHeading !== undefined) {
      openHeading.push(index);
      openHeading = undefined;
      return;
    }
    if (mentionsRequest(block, request)) {
      requested.push([index]);
    }
  });

  const kept = new Map<number, string>([[0, cutToTokens(blocks[0] ?? '', maxTokens)]]);
  let keptTokens = estimateTokensForString(kept.get(0) ?? '');
  for (const group of [...structural, ...requested]) {
    const pending = group.filter(index => !kept.has(index));
    const cost = pending.reduce((sum, index) => sum + estimateTokensForString(blocks[index] ?? ''), 0);
    if (pending.length === 0 || keptTokens + cost > maxTokens) {
      continue;
    }
    for (const index of pending) {
      kept.set(index, blocks[index] ?? '');
    }
    keptTokens += cost;
  }

  const body = [...kept.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block)
    .join('\n\n');
  const omitted = Math.max(0, Math.round(totalTokens - estimateTokensForString(body)));
  return `${body}\n\n(Only part of this page is shown: about ${String(omitted)} more tokens were left out, and no tool can show them.)`;
}

/** Trims each page's text in a Tavily extract result to the page budget. The JSON shape stays. */
export function budgetExtractPages(input: { content: string; request: ReadonlySet<string> }): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['pages'])) {
    return undefined;
  }
  const pages: unknown[] = [];
  let changed = false;
  for (const page of parsed['pages']) {
    const original = isRecord(page) ? page['text'] : undefined;
    if (!isRecord(page) || typeof original !== 'string') {
      pages.push(page);
      continue;
    }
    const text = budgetPageText({ text: original, request: input.request, maxTokens: PAGE_READ_TOKEN_BUDGET });
    changed ||= text !== original;
    pages.push({ ...page, text });
  }
  return changed ? JSON.stringify({ ...parsed, pages }) : undefined;
}

/** Keeps the first and last lines of a long stream; a short one is returned unchanged. */
function keepEdgeLines(text: string, hint: string): string {
  const lines = text.split('\n');
  if (lines.length <= SANDBOX_OUTPUT_EDGE_LINES * 2) {
    return text;
  }
  const omitted = lines.length - SANDBOX_OUTPUT_EDGE_LINES * 2;
  return [
    ...lines.slice(0, SANDBOX_OUTPUT_EDGE_LINES),
    `... ${String(omitted)} lines left out. ${hint} ...`,
    ...lines.slice(-SANDBOX_OUTPUT_EDGE_LINES),
  ].join('\n');
}

/**
 * Trims long output in a sandbox result: exec keeps it in response.result, run_code at the top-level stdout
 * and stderr. The exit code is a separate field and stays.
 */
export function budgetSandboxOutput(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const next: Record<string, unknown> = { ...parsed };
  let changed = false;
  for (const key of ['stdout', 'stderr']) {
    const value = parsed[key];
    if (typeof value === 'string') {
      const trimmed = keepEdgeLines(value, RUN_CODE_OUTPUT_HINT);
      if (trimmed !== value) {
        next[key] = trimmed;
        changed = true;
      }
    }
  }
  const response = parsed['response'];
  if (isRecord(response) && typeof response['result'] === 'string') {
    const trimmed = keepEdgeLines(response['result'], EXEC_OUTPUT_HINT);
    if (trimmed !== response['result']) {
      next['response'] = { ...response, result: trimmed };
      changed = true;
    }
  }
  return changed ? JSON.stringify(next) : undefined;
}

/**
 * Applies each tool's ingestion budget to the results in place, before the processor measures them.
 * Failures and screened-out results are left alone: the first is already a short message, the second
 * is never shown to the model.
 */
function applyIngestionBudgets(input: {
  results: ToolCallResult[];
  sandbox: Sandbox | undefined;
  context: readonly ContextMessage[];
}): void {
  let request: Set<string> | undefined;
  for (const result of input.results) {
    if (result.failure || result.screen?.action === 'withheld' || !result.info) {
      continue;
    }
    const content = result.message.content;
    const toolName = result.info.originalToolName;
    let budgeted: string | undefined;
    if (input.sandbox && result.info.toolSet === input.sandbox) {
      budgeted = budgetSandboxOutput(content);
    } else if (toolName === TAVILY_EXTRACT_TOOL_NAME) {
      request ??= requestWordsOf(input.context);
      budgeted = budgetExtractPages({ content, request });
    } else if (toolName === 'web_fetch') {
      request ??= requestWordsOf(input.context);
      const text = budgetPageText({ text: content, request, maxTokens: PAGE_READ_TOKEN_BUDGET });
      budgeted = text === content ? undefined : text;
    }
    if (budgeted !== undefined) {
      result.message.content = budgeted;
      result.outputTransform = 'truncated';
    }
  }
}

/** Runs the ingestion budgets on every chat, before the size thresholds see the results. */
export class IngestionBudgetProcessor implements ToolResponseProcessor {
  process(
    results: ToolCallResult[],
    execution: Readonly<AgentThreadExecutionContext>,
  ): Promise<ToolResponseProcessorResult> {
    applyIngestionBudgets({ results, sandbox: execution.sandbox, context: execution.context });
    return Promise.resolve({});
  }
}

export function ingestionBudgets(): AgentCapability {
  return { toolResponseProcessors: [new IngestionBudgetProcessor()] };
}

export class LargeToolResponseProcessor implements ToolResponseProcessor {
  private dynamicSubAgentsPresent: boolean;
  private individualTokenThreshold: number;
  private totalTokenThreshold: number;
  private previewNumberOfCharacters: number;
  private readonly logger: Logger;

  constructor(param: {
    dynamicSubAgentsPresent: boolean;
    individualTokenThreshold: number;
    totalTokenThreshold: number;
    previewNumberOfCharacters: number;
    logger: Logger;
  }) {
    if (param.individualTokenThreshold > param.totalTokenThreshold) {
      throw new Error(
        `individualTokenThreshold (${String(param.individualTokenThreshold)}) must be <= totalTokenThreshold (${String(param.totalTokenThreshold)})`,
      );
    }
    this.dynamicSubAgentsPresent = param.dynamicSubAgentsPresent;
    this.individualTokenThreshold = param.individualTokenThreshold;
    this.totalTokenThreshold = param.totalTokenThreshold;
    this.previewNumberOfCharacters = param.previewNumberOfCharacters;
    this.logger = param.logger.child({ module: 'LargeToolResponse' });
  }

  private createLargeToolResponseGuidance(options: {
    sandbox: Sandbox | undefined;
    toolName: string | undefined;
    serverId: string | undefined;
  }): string {
    // The first step is driven by the fetch-semantics registry (keyed by the
    // tool's original name), never by sniffing the result content.
    const semantics =
      options.toolName !== undefined
        ? emailFetchSemanticsFor({ toolName: options.toolName, serverId: options.serverId })
        : undefined;
    const firstStep =
      semantics !== undefined
        ? emailFetchGuidance(semantics)
        : 'Check if some parameter can be passed in order to reduce the output size.';
    const steps = [firstStep];

    if (options.sandbox) {
      steps.push(createSandboxLargeToolResponseGuidance());
    }

    if (this.dynamicSubAgentsPresent) {
      steps.push(createDynamicSubAgentLargeToolResponseGuidance());
    }

    return `The Agent has not seen this tool result. Do not present anything as if it came from this result.\n\nContent too big. To handle a large tool call the Agent can do the following:\n${steps
      .map((step, index) => `${String(index + 1)}. ${step}`)
      .join(
        '\n',
      )}\n\nIf the Agent cannot reduce the output or re-run the tool with a narrower request, it must tell the user the result was too large to use and answer only from what it actually has, saying so.`;
  }

  private createFileDumpMessage(params: { filePath: string; preview: string; originalContent: string }): string {
    const { filePath, preview, originalContent } = params;
    const steps: string[] = [
      dedent`Use sandbox to read parts of the file or extract data.
      Use ${SANDBOX_SCHEMA_INFER_TAG} to undertand the schema.`,
    ];

    if (this.dynamicSubAgentsPresent) {
      steps.push(
        `${createDynamicSubAgentLargeToolResponseGuidance()} The Agent must pass file path to sub-agent also.`,
      );
    }

    const guidance = `The Agent can do the following to handle it:\n${steps
      .map((step, index) => `${String(index + 1)}. ${step}`)
      .join('\n')}`;

    const structuralSummary = jsonStructuralSummary(originalContent);
    const structureSection = structuralSummary === undefined ? '' : `\n\nStructure:\n${structuralSummary}`;

    return `The Agent has not seen this tool result. Do not present anything as if it came from this result.\n\nContent too large. Result saved to: ${filePath}.\n\n${guidance}${structureSection}\n\nIf the Agent cannot read the saved file, it must tell the user the result was too large to use and answer only from what it actually has, saying so.\n\nPreview (first and last ${String(this.previewNumberOfCharacters)} chars):\n${preview}`;
  }

  private buildResultsWithInfo(results: ToolCallResult[], sandbox: Sandbox | undefined): ToolResultWithInfo[] {
    return results.map(toolCallResult => ({
      toolCallResult,
      originalContent: toolCallResult.message.content,
      originalTokens: estimateTokensForString(toolCallResult.message.content),
      category: categorize(toolCallResult, sandbox),
    }));
  }

  /**
   * Builds the bounded summary for an oversized MCP result. A recognized
   * email tool gets the metadata-first specialization; a recognized email
   * tool whose result is not JSON (the Gmail server renders human-readable
   * text when structuredContent is absent) gets a bounded text excerpt;
   * anything else gets the generic bounded summary. Returns undefined when
   * the result cannot be fully accounted for (caller takes the panic path).
   */
  private summarizeMcpResult(input: {
    entry: ToolResultWithInfo;
    toolName: string | undefined;
    serverId: string | undefined;
  }): OversizedResultSummary | undefined {
    const { entry, toolName, serverId } = input;
    if (toolName !== undefined) {
      const semantics = emailFetchSemanticsFor({ toolName, serverId });
      if (semantics !== undefined) {
        // Probe the shape first: JSON results take the structured path,
        // human-readable text takes the bounded excerpt path. Probing avoids
        // a doomed full-content encode + JSON.parse for text results.
        if (looksLikeJsonObjectOrArray(entry.originalContent)) {
          const email = summarizeEmailResult({ content: entry.originalContent, semantics });
          if (email !== undefined) {
            return email;
          }
          this.logger.warn('email result missed its fetch-semantics shape; falling back to generic summary', {
            tool: toolName,
            fingerprint: oversizedResultFingerprint({ toolName, content: entry.originalContent }),
          });
        } else {
          // The JSON summarizers cannot account for a non-JSON result;
          // without this text fallback the generic summary below also fails
          // and the caller takes the panic path, leaving the model with
          // nothing.
          const text = summarizeEmailTextResult({ content: entry.originalContent, semantics });
          if (text !== undefined) {
            return text;
          }
        }
      }
    }
    // Efficiency note: for text content the generic pass above costs one full
    // UTF-8 encode plus a throwing JSON.parse before the text fallback below
    // encodes again. This stands deliberately: skipping the generic pass for
    // non-JSON-looking content is not behavior-preserving — the generic
    // summarizer also accounts for JSON scalars ('"str"', '42') through its
    // text-excerpt branch, with different statement formatting pinned by
    // tests. Input is bounded to 1 MiB, so the second pass is a transient
    // ~1MB allocation costing single-digit milliseconds once per oversized
    // result; threading the byte count through both exported summarizers
    // would not buy enough to justify the API churn.
    const generic = summarizeOversizedResult({
      content: entry.originalContent,
      collectionField: undefined,
      totalCount: undefined,
      totalDisplay: undefined,
      next: undefined,
      totalBytes: undefined,
    });
    if (generic !== undefined) {
      return generic;
    }
    // Non-JSON content that the email paths couldn't account for: if it's
    // human-readable text, give a bounded excerpt rather than the panic path.
    // Binary/hostile blobs still return undefined -> panic.
    return summarizeGenericTextResult({
      content: entry.originalContent,
      toolName,
    });
  }

  private blockResult(
    entry: ToolResultWithInfo,
    pendingSandboxDumps: ToolResultWithInfo[],
    sandbox: Sandbox | undefined,
    // When true (the batch-total loop), only replace if the replacement is
    // actually smaller. A structured excerpt of a sub-threshold result can be
    // pure framing overhead; replacing would grow the batch total this loop
    // exists to shrink, while showing the model nothing it does not already
    // have. The individual-threshold path passes false: an oversized result
    // gets its structured guardrails even when they cost a few tokens.
    requireReduction = false,
  ): Promise<number> {
    // Screening withholds whole results by replacing the message content; a
    // withheld result is small and must never be summarized or counted as
    // seen. The screen classifier already saw the original rawContent,
    // which this processor never touches.
    if (entry.toolCallResult.screen?.action === 'withheld') {
      return Promise.resolve(0);
    }
    const preview = createContentPreview(entry.originalContent, this.previewNumberOfCharacters);

    let newContent: string;
    let structured = false;
    let queueSandboxDump = false;
    switch (entry.category) {
      case 'failure':
        newContent = entry.originalContent.slice(0, FAILURE_MESSAGE_TRUNCATION_LENGTH);
        break;
      case 'sandbox': {
        const { head, charCount } = createBoundedHead(entry.originalContent, SANDBOX_LARGE_OUTPUT_HEAD_CHARS);
        const headLineCount = head.split('\n').length;
        const totalLineCount = entry.originalContent.split('\n').length;
        newContent = `The Agent has seen only the first ${String(headLineCount)} of ${String(totalLineCount)} lines (${String(head.length)} of ${String(charCount)} characters) of this output; the rest was not seen. Do not present anything beyond these lines as if it came from this result.\n\nRe-run a safe inspection command with output.head_lines, output.tail_lines, and/or output.grep. Do not repeat a side-effecting command. Use write_file to write to a file; for existing files, use apply_patch or replace_text. ${sandboxRawOutputStorageGuidance(entry.originalContent)}\n\nIf the Agent cannot re-run the tool with a narrower request, it must tell the user the result was too large to use and answer only from what it actually has, saying so.\n\nHead:\n${head}`;
        break;
      }
      case 'mcp': {
        const toolName = entry.toolCallResult.info?.originalToolName;
        const serverId = entry.toolCallResult.info?.toolSet.id;
        const summary = this.summarizeMcpResult({ entry, toolName, serverId });
        if (summary !== undefined) {
          newContent = renderOversizedResultSummary(summary);
          structured = true;
          if (summary.next === null) {
            // Tripwire: an oversized result with no re-fetch path. Logged for
            // product review (is a fetch-semantics entry or a paging story
            // needed?); the blob is never stashed.
            this.logger.warn('oversized result has no re-fetch path', {
              tool: toolName,
              fingerprint: oversizedResultFingerprint({
                toolName: toolName ?? 'unknown',
                content: entry.originalContent,
              }),
            });
          }
          break;
        }
        // Panic path: the result could not be fully accounted for under the
        // parse/walk budgets. Say nothing about its content beyond a bounded
        // preview; log a content-free fingerprint for diagnosis.
        this.logger.warn('oversized result not summarizable; using generic guidance', {
          tool: toolName,
          fingerprint: oversizedResultFingerprint({
            toolName: toolName ?? 'unknown',
            content: entry.originalContent,
          }),
        });
        newContent = `${this.createLargeToolResponseGuidance({ sandbox, toolName, serverId })}\n\nPreview (first and last ${String(this.previewNumberOfCharacters)} chars):\n${preview}`;
        if (sandbox) {
          queueSandboxDump = true;
        }
        break;
      }
    }

    const newTokens = estimateTokensForString(newContent);
    if (requireReduction && newTokens >= entry.originalTokens) {
      // Replacing would not shrink the result; leave the original untouched
      // (and do not queue a sandbox dump for output the model can already see).
      return Promise.resolve(0);
    }
    if (queueSandboxDump) {
      pendingSandboxDumps.push(entry);
    }

    entry.toolCallResult.message.content = newContent;
    entry.toolCallResult.isStructuredContent = structured;
    // The change is a host decision, and the event must say so in a field the host owns: the
    // text alone cannot prove the model never saw the real output. It sits beside any
    // remediation rather than in it, so a failure keeps its own reason.
    entry.toolCallResult.outputTransform = entry.category === 'failure' ? 'truncated' : 'replaced';
    // rawContent is deliberately left intact: output screening classifies the
    // original bytes, and must never see a laundered projection instead.
    return Promise.resolve(Math.max(0, entry.originalTokens - newTokens));
  }

  private async uploadToSandboxAndPrependFilePath(
    entry: ToolResultWithInfo,
    index: number,
    sandbox: Sandbox,
  ): Promise<SandboxInfo | undefined> {
    if (!entry.toolCallResult.info) {
      throw new Error(`Unreachable`);
    }
    const sanitizedName = entry.toolCallResult.info.originalToolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const epoch = Date.now();
    const fileName = `${sanitizedName}_${String(index)}_${String(epoch)}.txt`;
    try {
      const stored = await sandbox.writeArtifact({
        fileName,
        content: Buffer.from(entry.originalContent),
        sourceTool: entry.toolCallResult.info,
      });
      const preview = createContentPreview(entry.originalContent, this.previewNumberOfCharacters);
      entry.toolCallResult.message.content = this.createFileDumpMessage({
        filePath: stored.filePath,
        preview,
        originalContent: entry.originalContent,
      });
      entry.toolCallResult.isStructuredContent = false;
      return stored.sandboxCreated;
    } catch (error) {
      this.logger.error('Failed to upload to sandbox', extractErrorLogFields(error));
      return undefined;
    }
  }

  private async executeSandboxDumps(entries: ToolResultWithInfo[], sandbox: Sandbox): Promise<SandboxInfo | undefined> {
    const results = await Promise.all(
      entries.map((entry, index) => this.uploadToSandboxAndPrependFilePath(entry, index, sandbox)),
    );
    return results.find(r => r !== undefined);
  }

  async process(
    results: ToolCallResult[],
    execution: Readonly<AgentThreadExecutionContext>,
  ): Promise<ToolResponseProcessorResult> {
    const sandbox = execution.sandbox;
    const resultsWithInfo = this.buildResultsWithInfo(results, sandbox);
    let runningTotal = resultsWithInfo.reduce((sum, e) => sum + e.originalTokens, 0);

    if (runningTotal < this.individualTokenThreshold) {
      return {};
    }

    const pendingSandboxDumps: ToolResultWithInfo[] = [];

    const unblocked: ToolResultWithInfo[] = [];
    for (const entry of resultsWithInfo) {
      if (entry.originalTokens >= this.individualTokenThreshold) {
        runningTotal -= await this.blockResult(entry, pendingSandboxDumps, sandbox);
      } else {
        unblocked.push(entry);
      }
    }

    const sortedUnblocked = [...unblocked].sort((a, b) => b.originalTokens - a.originalTokens);
    for (const entry of sortedUnblocked) {
      if (runningTotal < this.totalTokenThreshold) {
        break;
      }
      // requireReduction: these results are under the individual bar, so the
      // only justification for touching them is shrinking the batch total.
      runningTotal -= await this.blockResult(entry, pendingSandboxDumps, sandbox, true);
    }

    const sandboxCreated = sandbox ? await this.executeSandboxDumps(pendingSandboxDumps, sandbox) : undefined;
    return sandboxCreated !== undefined ? { sandboxCreated } : {};
  }
}

export interface LargeToolResponseSettings {
  individualTokenThreshold?: number | undefined;
  totalTokenThreshold?: number | undefined;
  previewNumberOfCharacters?: number | undefined;
}

export function largeToolResponse(options: {
  dynamicSubAgentsPresent: boolean;
  settings?: LargeToolResponseSettings | undefined;
  logger: Logger;
  tracing: AgentTracing;
}): AgentCapability {
  return {
    toolResponseProcessors: [
      new LargeToolResponseProcessor({
        dynamicSubAgentsPresent: options.dynamicSubAgentsPresent,
        individualTokenThreshold: options.settings?.individualTokenThreshold ?? DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD,
        totalTokenThreshold: options.settings?.totalTokenThreshold ?? DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD,
        previewNumberOfCharacters: options.settings?.previewNumberOfCharacters ?? DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS,
        logger: options.logger,
      }),
    ],
  };
}
