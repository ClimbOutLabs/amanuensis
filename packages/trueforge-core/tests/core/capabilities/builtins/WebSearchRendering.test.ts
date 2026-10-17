import * as fs from 'node:fs';
import * as path from 'node:path';
import { LargeToolResponseProcessor } from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import {
  renderWebFetchResultMarkdown,
  renderWebSearchResultsMarkdown,
  WebSearchRenderingProcessor,
} from '../../../../src/core/capabilities/builtins/WebSearchRendering';
import type { InternalToolCallInfo } from '../../../../src/core/llm/LLMTypes';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { buildCanonicalToolCallResult } from '../../../../src/core/runtime/AgentThread';
import { makeMockIMCPServer } from '../../harnessMocks';

const FIXTURE_PATH = path.join(__dirname, 'fixtures/parallel-web-web-search.json');
const FIXTURE: { content: string } = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

describe('renderWebSearchResultsMarkdown', () => {
  it('leaves non-search JSON untouched', () => {
    expect(renderWebSearchResultsMarkdown(JSON.stringify({ status: 'ok', data: { count: 3 } }))).toBeUndefined();
    expect(renderWebSearchResultsMarkdown(JSON.stringify({ results: 'not-an-array' }))).toBeUndefined();
    expect(renderWebSearchResultsMarkdown('not json at all')).toBeUndefined();
    expect(
      renderWebSearchResultsMarkdown(JSON.stringify({ result: { results: [{ noUrlField: true }] } })),
    ).toBeUndefined();
  });

  it('unwraps the tool.response.v2 envelope, truncates excerpts on a word boundary, and surfaces warnings', () => {
    const content = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: {
        search_id: 'search_1',
        results: [
          {
            url: 'https://example.com/long',
            title: 'Long Excerpt Result',
            publish_date: '2024-01-01',
            excerpts: [`${'word '.repeat(100)}tail`, 'A short second excerpt.'],
          },
        ],
        warnings: ['upstream provider was slow'],
        session_id: 'redacted',
      },
    });

    const rendered = renderWebSearchResultsMarkdown(content);

    expect(rendered).toBeDefined();
    expect(rendered).toContain('1. Long Excerpt Result');
    expect(rendered).toContain('2024-01-01');
    expect(rendered).toContain('A short second excerpt.');
    expect(rendered).toContain('…');
    const firstExcerptLine = rendered?.split('\n').find(line => line.includes('word word'));
    expect(firstExcerptLine?.trim().length).toBeLessThanOrEqual(300 + 1); // + ellipsis char
    expect(rendered).toContain('Warnings: upstream provider was slow');
  });

  it('renders the captured parallel-web fixture: entry count, a known title, and a 300-char excerpt cap', () => {
    const rendered = renderWebSearchResultsMarkdown(FIXTURE.content);

    expect(rendered).toBeDefined();
    const entryLines = rendered?.split('\n\n').filter(block => /^\d+\. /.test(block)) ?? [];
    expect(entryLines).toHaveLength(10);
    expect(rendered).toContain('Memantine Interactions Checker - Drugs.com');
    expect(rendered).toContain('https://www.drugs.com/drug-interactions/memantine.html');
    expect(rendered).not.toContain('results, showing');

    for (const block of entryLines) {
      const lines = block.split('\n').map(line => line.trim());
      // First two lines are always the numbered title and the URL; anything after is an excerpt.
      const excerptLines = lines.slice(2).filter(line => !/^\d{4}-\d{2}-\d{2}$/.test(line));
      for (const excerpt of excerptLines) {
        expect(excerpt.length).toBeLessThanOrEqual(301); // 300 chars + a trailing ellipsis character
      }
    }
  });
});

describe('renderWebFetchResultMarkdown', () => {
  it('unwraps a tool.response.v2 envelope the same way as web_search', () => {
    const content = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: {
        results: [{ url: 'https://example.com/fetched', title: 'Envelope Fetch', content: 'Fetched body text.' }],
        warnings: null,
        session_id: 'redacted',
      },
    });

    const rendered = renderWebFetchResultMarkdown(content);

    expect(rendered).toBeDefined();
    expect(rendered).toContain('Envelope Fetch');
    expect(rendered).toContain('Fetched body text.');
  });

  it('leaves non-fetch JSON untouched', () => {
    expect(renderWebFetchResultMarkdown('not json at all')).toBeUndefined();
    expect(renderWebFetchResultMarkdown(JSON.stringify({ status: 'ok' }))).toBeUndefined();
  });

  it('does not truncate oversized fetch content; leaves it for LargeToolResponseProcessor to handle', () => {
    const largeContent = 'x'.repeat(2000);
    const content = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: {
        results: [{ url: 'https://example.com/large', title: 'Large Page', content: largeContent }],
        warnings: null,
        session_id: 'redacted',
      },
    });

    const rendered = renderWebFetchResultMarkdown(content);

    expect(rendered).toBeDefined();
    expect(rendered).toContain('Large Page');
    expect(rendered).toContain(largeContent);
    // Should NOT contain the truncation message
    expect(rendered).not.toContain('content continues');
    expect(rendered).not.toContain('large-output pager');
  });
});

function toolCallInfoFor(originalToolName: string, type: 'mcp' | 'truefoundry-system' = 'mcp'): InternalToolCallInfo {
  return {
    type,
    mcp_server_id: type === 'mcp' ? 'parallel-web' : '',
    mcp_server_name: type === 'mcp' ? 'parallel-web' : '',
    original_tool_name: originalToolName,
  };
}

function makeToolResult(params: {
  rawContent: string;
  /** The name of the function the model actually invoked — `call_tool` when dispatched. */
  dispatchedFunctionName: string;
  /** The underlying MCP tool name the host resolved, e.g. `web_search`. */
  underlyingToolName: string;
  failure?: boolean;
}): ToolCallResult {
  const { rawContent, dispatchedFunctionName, underlyingToolName, failure = false } = params;
  const toolSet = makeMockIMCPServer({ name: 'deferred-tools', preload: true });
  return {
    message: { role: 'tool', tool_call_id: 'call-1', content: rawContent },
    images: [],
    rawContent,
    toolCallInfo: toolCallInfoFor(underlyingToolName),
    screen: undefined,
    // `info` reflects the function the model actually called (the dispatcher's own name when
    // reached through `call_tool`), which is why matching against it — the pre-fix bug — never
    // fires for a dispatched call.
    info: { toolSet, originalToolName: dispatchedFunctionName },
    failure,
    isStructuredContent: true,
    completedAt: '2026-09-07T00:00:00.000Z',
    memoized: false,
    repeatCount: 1,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'executed_ok',
    remediation: undefined,
    admissionProvenance: { source: 'automatic' },
  };
}

describe('WebSearchRenderingProcessor', () => {
  it('renders a direct (non-dispatched) web_search call', async () => {
    const rawJson = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: {
        search_id: 'search_1',
        results: [{ title: 'A Result', url: 'https://example.com/a', excerpts: ['A snippet.'] }],
        warnings: null,
        session_id: 'redacted',
      },
    });
    const result = makeToolResult({
      rawContent: rawJson,
      dispatchedFunctionName: 'web_search',
      underlyingToolName: 'web_search',
    });

    await new WebSearchRenderingProcessor().process([result]);

    expect(result.message.content).not.toBe(rawJson);
    expect(result.message.content).toContain('A Result');
    expect(result.outputTransform).toBe('replaced');
    expect(result.rawContent).toBe(rawJson);
  });

  it('renders a web_search call reached through the call_tool dispatcher (the #125 bug)', async () => {
    const rawJson = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: {
        search_id: 'search_1',
        results: [{ url: 'https://drugs.example/interactions', title: 'Interaction Checker', excerpts: ['x'] }],
        warnings: null,
        session_id: 'redacted',
      },
    });
    const result = makeToolResult({
      rawContent: rawJson,
      // The model called the dispatcher, not web_search directly.
      dispatchedFunctionName: 'call_tool',
      underlyingToolName: 'web_search',
    });
    expect(result.info?.originalToolName).toBe('call_tool');

    await new WebSearchRenderingProcessor().process([result]);

    expect(result.message.content).not.toBe(rawJson);
    expect(result.message.content).toContain('Interaction Checker');
    expect(result.message.content).toContain('https://drugs.example/interactions');
    expect(result.outputTransform).toBe('replaced');
    expect(result.rawContent).toBe(rawJson);
  });

  it('renders a web_fetch call reached through the call_tool dispatcher', async () => {
    const rawJson = JSON.stringify({
      schema_version: 'tool.response.v2',
      outcome: { disposition: 'executed_ok' },
      result: {
        results: [{ url: 'https://example.com/fetched', title: 'Fetched Page', excerpts: ['Body text.'] }],
        warnings: null,
        session_id: 'redacted',
      },
    });
    const result = makeToolResult({
      rawContent: rawJson,
      dispatchedFunctionName: 'call_tool',
      underlyingToolName: 'web_fetch',
    });

    await new WebSearchRenderingProcessor().process([result]);

    expect(result.message.content).toContain('Fetched Page');
    expect(result.message.content).toContain('Body text.');
    expect(result.outputTransform).toBe('replaced');
  });

  it('ignores a call_tool dispatch to a non-search, non-fetch tool', async () => {
    const rawJson = JSON.stringify({ result: { ok: true } });
    const result = makeToolResult({
      rawContent: rawJson,
      dispatchedFunctionName: 'call_tool',
      underlyingToolName: 'create_issue',
    });

    await new WebSearchRenderingProcessor().process([result]);

    expect(result.message.content).toBe(rawJson);
    expect(result.outputTransform).toBeUndefined();
  });

  it('leaves the raw content selection untouched when the payload is not search-shaped', async () => {
    const rawJson = JSON.stringify({ status: 'ok' });
    const result = makeToolResult({
      rawContent: rawJson,
      dispatchedFunctionName: 'web_search',
      underlyingToolName: 'web_search',
    });

    await new WebSearchRenderingProcessor().process([result]);

    expect(result.message.content).toBe(rawJson);
    expect(result.outputTransform).toBeUndefined();
  });

  it('keeps the original JSON as the durable, UI-visible raw content and marks the transform', async () => {
    const result = makeToolResult({
      rawContent: FIXTURE.content,
      dispatchedFunctionName: 'call_tool',
      underlyingToolName: 'web_search',
    });

    await new WebSearchRenderingProcessor().process([result]);

    expect(result.message.content).not.toBe(FIXTURE.content);
    expect(result.outputTransform).toBe('replaced');
    // The durable record keeps the raw payload verbatim, excerpts included, regardless of what
    // the model was shown.
    expect(result.rawContent).toBe(FIXTURE.content);
    const rawParsed: { result: { results: { excerpts: string[] }[] } } = JSON.parse(result.rawContent);
    expect(rawParsed.result.results[1]?.excerpts[0]).toBe(
      '43 medications are known to interact with memantine. Includes metformin, hydrochlorothiazide, acyclovir.',
    );

    const canonical = buildCanonicalToolCallResult('main', result);
    const visibleEnvelope: unknown = JSON.parse(canonical.event.content);
    // The event the UI renders must carry the exact original payload, excerpts and all — not
    // the rendered markdown the model saw.
    expect(visibleEnvelope).toMatchObject({ result: JSON.parse(FIXTURE.content) });
    expect(canonical.model_message.content).toContain('drugs.com');
    expect(canonical.model_message.content).not.toContain('search_b8afbbceee7cefa39c638c6aca9f4a5c');
  });
});

describe('WebSearchRenderingProcessor + LargeToolResponseProcessor ordering', () => {
  it('renders a 30 KB search result instead of letting it hit the large-tool-response file-dump path', async () => {
    expect(FIXTURE.content.length).toBeGreaterThan(20_000);

    const result = makeToolResult({
      rawContent: FIXTURE.content,
      dispatchedFunctionName: 'call_tool',
      underlyingToolName: 'web_search',
    });

    // Registration order in builtinsFromSpec.ts puts webSearchRendering() ahead of
    // largeToolResponse(); reproduce that ordering here by running the processors in sequence,
    // exactly as AgentThread's for-loop over `toolResponseProcessors` does.
    await new WebSearchRenderingProcessor().process([result]);
    await new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 6000,
      totalTokenThreshold: 10000,
      previewNumberOfCharacters: 100,
      logger: { child: () => ({ error: () => undefined, warn: () => undefined }) } as never,
    }).process([result], {
      threadId: 'main',
      sandbox: undefined,
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
      context: [],
    });

    // Rendered by WebSearchRendering, and never blocked by the large-tool-response guard.
    expect(result.message.content).toContain('drugs.com');
    expect(result.message.content).not.toContain('Content too big');
    expect(result.message.content).not.toContain('Content too large');
    expect(result.message.content.length).toBeLessThan(6000);
    expect(result.outputTransform).toBe('replaced');
  });

  it('without web-search rendering, the same fixture would have hit the large-tool-response guard', async () => {
    // Sanity check that the fixture is genuinely large enough to prove the ordering test above
    // means something: run LargeToolResponse alone, with no prior render, and confirm it blocks.
    // (Path A rework: oversized results get a structured summary with truncated:true,
    // not the old "Content too big" panic text.)
    const result = makeToolResult({
      rawContent: FIXTURE.content,
      dispatchedFunctionName: 'call_tool',
      underlyingToolName: 'web_search',
    });

    await new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 6000,
      totalTokenThreshold: 10000,
      previewNumberOfCharacters: 100,
      logger: { child: () => ({ error: () => undefined, warn: () => undefined }) } as never,
    }).process([result], {
      threadId: 'main',
      sandbox: undefined,
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
      context: [],
    });

    expect(result.message.content).toContain('"truncated":true');
    expect(result.message.content).toContain('were not seen');
  });
});
