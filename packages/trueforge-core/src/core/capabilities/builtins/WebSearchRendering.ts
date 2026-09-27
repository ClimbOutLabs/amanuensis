import type { InternalToolCallInfo } from '../../llm/LLMTypes';
import type { ToolCallResult } from '../../mcp/executeToolCalls';
import type { AgentCapability } from '../AgentCapability';
import type { ToolResponseProcessor, ToolResponseProcessorResult } from '../ToolResponseProcessor';

/**
 * Observed failure mode: a `web_search` tool result too large for the model
 * gets replaced with file-dump guidance, and the model spends many steps
 * reading the dumped JSON in chunks to find URLs it could have read directly.
 * Rendering the small, useful part of a search result up front — title, URL,
 * a short excerpt — keeps the common case a single call and answer, and
 * keeps the rendered text well under the size that would trigger that path.
 *
 * Search and fetch tools are frequently reached through the host's `call_tool`
 * dispatcher rather than called directly, so the dispatcher's own function
 * name (`call_tool`) is never a usable signal. The host always resolves the
 * underlying tool identity onto `toolCallInfo.original_tool_name` (see
 * DeferredTool.toolCallInfo), for both direct and dispatched calls, so that —
 * not the function name a particular provider happened to invoke — is what
 * this processor matches on.
 */
export const WEB_SEARCH_RENDER_MAX_RESULTS = 10;
const WEB_SEARCH_EXCERPTS_PER_RESULT = 2;
const WEB_SEARCH_EXCERPT_MAX_CHARS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool is treated as a search tool when it is named exactly `web_search`. */
function isSearchToolName(name: string): boolean {
  return name.toLowerCase() === 'web_search';
}

/** A tool is treated as a fetch tool when it is named exactly `web_fetch`. */
function isFetchToolName(name: string): boolean {
  return name.toLowerCase() === 'web_fetch';
}

/**
 * The underlying MCP tool name for a result, resolved through the `call_tool`
 * dispatcher when the model reached it that way. Only `toolCallInfo` (host-
 * enriched per-call metadata, set for every dispatch path) carries this;
 * `result.info.originalToolName` is the name of whatever function the model
 * actually invoked, which is `call_tool` itself when dispatched.
 */
function underlyingToolName(toolCallInfo: InternalToolCallInfo | undefined): string | undefined {
  return toolCallInfo?.type === 'mcp' ? toolCallInfo.original_tool_name : undefined;
}

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const boundary = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
  return `${slice.slice(0, boundary).trimEnd()}…`;
}

/**
 * Excerpt strings for one result item from a tool.response.v2 envelope.
 * Prefers `excerpts` (an array of strings), and falls back to `content`
 * (a single string, used by the web_fetch tool).
 */
function collectExcerpts(item: Record<string, unknown>): string[] {
  const excerpts = item['excerpts'];
  if (Array.isArray(excerpts)) {
    const strings = excerpts.filter((e): e is string => typeof e === 'string' && e.trim().length > 0);
    if (strings.length > 0) {
      return strings.map(e => e.trim());
    }
  }
  // Fallback to content field (used by web_fetch tool)
  const content = stringField(item, 'content');
  return content === undefined ? [] : [content];
}

interface RenderableResult {
  title: string;
  url: string;
  publishDate: string | undefined;
  excerpts: string[];
}

interface UnwrappedResults {
  results: unknown[];
  warnings: unknown;
}

/**
 * Extract results and warnings from a `tool.response.v2` dispatcher
 * envelope (`{schema_version, outcome, result: {results, warnings}}`)
 * that MCP tools wrap every response in.
 */
function unwrapResults(parsed: unknown): UnwrappedResults | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const envelopeResult = parsed['result'];
  if (isRecord(envelopeResult) && Array.isArray(envelopeResult['results'])) {
    return { results: envelopeResult['results'], warnings: envelopeResult['warnings'] };
  }
  return undefined;
}

function parseResultItems(results: unknown[]): RenderableResult[] {
  const items: RenderableResult[] = [];
  for (const raw of results) {
    if (!isRecord(raw)) {
      continue;
    }
    const url = stringField(raw, 'url');
    if (url === undefined) {
      continue;
    }
    items.push({
      title: stringField(raw, 'title') ?? url,
      url,
      publishDate: stringField(raw, 'publish_date'),
      excerpts: collectExcerpts(raw),
    });
  }
  return items;
}

function formatWarnings(warnings: unknown): string | undefined {
  if (warnings === null || warnings === undefined) {
    return undefined;
  }
  if (Array.isArray(warnings)) {
    const strings = warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
    return strings.length > 0 ? `Warnings: ${strings.join('; ')}` : undefined;
  }
  if (typeof warnings === 'string' && warnings.trim().length > 0) {
    return `Warnings: ${warnings.trim()}`;
  }
  return undefined;
}

/**
 * Render a search-tool JSON payload into compact markdown, or `undefined`
 * when `content` is not JSON, is not shaped like a search result (no
 * `results` array at the top level or under a `tool.response.v2` envelope's
 * `result`), or is a search tool with no usable entries — in every such case
 * the caller leaves the original content untouched.
 */
export function renderWebSearchResultsMarkdown(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const unwrapped = unwrapResults(parsed);
  if (unwrapped === undefined) {
    return undefined;
  }

  const items = parseResultItems(unwrapped.results);
  if (items.length === 0) {
    return undefined;
  }

  const shown = items.slice(0, WEB_SEARCH_RENDER_MAX_RESULTS);
  const entries = shown.map((item, index) => {
    const lines = [`${String(index + 1)}. ${item.title}`, `   ${item.url}`];
    if (item.publishDate !== undefined) {
      lines.push(`   ${item.publishDate}`);
    }
    for (const excerpt of item.excerpts.slice(0, WEB_SEARCH_EXCERPTS_PER_RESULT)) {
      lines.push(`   ${truncateAtWordBoundary(excerpt, WEB_SEARCH_EXCERPT_MAX_CHARS)}`);
    }
    return lines.join('\n');
  });

  let rendered = entries.join('\n\n');
  if (items.length > WEB_SEARCH_RENDER_MAX_RESULTS) {
    rendered += `\n\n${String(items.length)} results, showing ${String(WEB_SEARCH_RENDER_MAX_RESULTS)}`;
  }
  const warningsLine = formatWarnings(unwrapped.warnings);
  if (warningsLine !== undefined) {
    rendered += `\n\n${warningsLine}`;
  }
  return rendered;
}

/**
 * Render a fetch-tool JSON payload into compact markdown, or `undefined`
 * under the same conditions as `renderWebSearchResultsMarkdown`. Each result
 * gets a larger per-item budget than a search excerpt, since fetch is asked
 * for a specific page rather than a set of candidates.
 *
 * Unlike search results, fetch results are not truncated here; if the content
 * exceeds the model's token budget, LargeToolResponseProcessor will handle it
 * by storing the full response and providing paging guidance. This preserves
 * the full fetched content for the model to access through the sandbox pager.
 */
export function renderWebFetchResultMarkdown(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const unwrapped = unwrapResults(parsed);
  if (unwrapped === undefined) {
    return undefined;
  }

  const items = parseResultItems(unwrapped.results);
  if (items.length === 0) {
    return undefined;
  }

  const entries = items.map(item => {
    const body = item.excerpts.join('\n\n');
    const lines = [item.title, item.url];
    if (body.length > 0) {
      lines.push(body);
    }
    return lines.join('\n');
  });

  const warningsLine = formatWarnings(unwrapped.warnings);
  return warningsLine === undefined ? entries.join('\n\n') : `${entries.join('\n\n')}\n\n${warningsLine}`;
}

export class WebSearchRenderingProcessor implements ToolResponseProcessor {
  // The AgentThreadExecutionContext parameter is part of the ToolResponseProcessor
  // contract but this processor is text-only and needs none of it.
  process(results: ToolCallResult[]): Promise<ToolResponseProcessorResult> {
    for (const result of results) {
      if (result.failure) {
        continue;
      }
      const toolName = underlyingToolName(result.toolCallInfo);
      if (toolName === undefined) {
        continue;
      }
      const rendered = isSearchToolName(toolName)
        ? renderWebSearchResultsMarkdown(result.message.content)
        : isFetchToolName(toolName)
          ? renderWebFetchResultMarkdown(result.message.content)
          : undefined;
      if (rendered === undefined) {
        continue;
      }
      result.message.content = rendered;
      result.isStructuredContent = false;
      // The model-facing text is now a host rendering of the raw JSON, not the raw
      // provider output itself; rawContent (unchanged) still carries that for the UI.
      result.outputTransform = 'replaced';
    }
    return Promise.resolve({});
  }
}

export function webSearchRendering(): AgentCapability {
  return {
    toolResponseProcessors: [new WebSearchRenderingProcessor()],
  };
}
