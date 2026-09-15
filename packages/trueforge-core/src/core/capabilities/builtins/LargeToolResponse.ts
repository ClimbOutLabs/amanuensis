import dedent from 'dedent';
import type { Logger } from 'winston';
import { estimateTokensForString } from '../../llm/usage';
import type { ToolCallResult } from '../../mcp/executeToolCalls';
import type { Sandbox, SandboxInfo } from '../../sandbox/Sandbox';
import { createSandboxLargeToolResponseGuidance, SANDBOX_SCHEMA_INFER_TAG } from '../../sandbox/Sandbox';
import { extractErrorLogFields } from '../../util/errorLogFields';
import type { AgentCapability } from '../AgentCapability';
import type { AgentThreadExecutionContext } from '../AgentContextProcessor';
import type { ToolResponseProcessor, ToolResponseProcessorResult } from '../ToolResponseProcessor';
import { createDynamicSubAgentLargeToolResponseGuidance } from './DynamicSubAgents';

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
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

  private createLargeToolResponseGuidance(sandbox: Sandbox | undefined): string {
    const steps = ['Check if some parameter can be passed in order to reduce the output size.'];

    if (sandbox) {
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

  private blockResult(
    entry: ToolResultWithInfo,
    pendingSandboxDumps: ToolResultWithInfo[],
    sandbox: Sandbox | undefined,
  ): number {
    const preview = createContentPreview(entry.originalContent, this.previewNumberOfCharacters);

    let newContent: string;
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
      case 'mcp':
        newContent = `${this.createLargeToolResponseGuidance(sandbox)}\n\nPreview (first and last ${String(this.previewNumberOfCharacters)} chars):\n${preview}`;
        if (sandbox) {
          pendingSandboxDumps.push(entry);
        }
        break;
    }

    entry.toolCallResult.message.content = newContent;
    entry.toolCallResult.isStructuredContent = false;
    // The change is a host decision, and the event must say so in a field the host owns: the
    // text alone cannot prove the model never saw the real output. It sits beside any
    // remediation rather than in it, so a failure keeps its own reason.
    entry.toolCallResult.outputTransform = entry.category === 'failure' ? 'truncated' : 'replaced';
    return Math.max(0, entry.originalTokens - estimateTokensForString(newContent));
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
        runningTotal -= this.blockResult(entry, pendingSandboxDumps, sandbox);
      } else {
        unblocked.push(entry);
      }
    }

    const sortedUnblocked = [...unblocked].sort((a, b) => b.originalTokens - a.originalTokens);
    for (const entry of sortedUnblocked) {
      if (runningTotal < this.totalTokenThreshold) {
        break;
      }
      runningTotal -= this.blockResult(entry, pendingSandboxDumps, sandbox);
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
