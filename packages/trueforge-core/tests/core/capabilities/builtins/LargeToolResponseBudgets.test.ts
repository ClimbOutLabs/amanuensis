import { CALENDAR_SERVER_ID } from '../../../../src/core/calendar/toolContract';
import type { AgentThreadExecutionContext } from '../../../../src/core/capabilities/AgentContextProcessor';
import {
  budgetPageText,
  budgetSandboxOutput,
  IngestionBudgetProcessor,
  PAGE_READ_TOKEN_BUDGET,
  SANDBOX_OUTPUT_EDGE_LINES,
} from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import { renderWebSearchResultsMarkdown } from '../../../../src/core/capabilities/builtins/WebSearchRendering';
import { estimateTokensForString } from '../../../../src/core/llm/usage';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import type { IToolSet } from '../../../../src/core/mcp/IMCPServer';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { FetchedPageStore, recordFetchedPages } from '../../../../src/core/search/fetchedPages';
import { groundPlace } from '../../../../src/core/search/groundPlace';
import { TAVILY_EXTRACT_TOOL_NAME } from '../../../../src/core/search/TavilyClient';
import { SPACE_SERVER_ID } from '../../../../src/core/spaces/toolContract';
import { makeMockIMCPServer, makeStubPublicSandbox } from '../../harnessMocks';

const NO_REQUEST: ReadonlySet<string> = new Set();

/** Paragraphs of filler text, each with a distinct marker so a test can tell which were kept. */
function paragraph(marker: string): string {
  return `${marker} ${'lorem ipsum dolor sit amet consectetur '.repeat(12)}`.trim();
}

function longPage(sections: number): string {
  return Array.from({ length: sections }, (_, index) =>
    [`## Section ${String(index)}`, paragraph(`lead-${String(index)}`), paragraph(`tail-${String(index)}`)].join(
      '\n\n',
    ),
  ).join('\n\n');
}

function toolResult(input: { content: string; toolName: string; toolSet?: IToolSet | undefined }): ToolCallResult {
  return {
    message: { role: 'tool', tool_call_id: 'call-1', content: input.content },
    rawContent: input.content,
    images: [],
    toolCallInfo: { type: 'mcp', mcp_server_id: 'web', mcp_server_name: 'web', original_tool_name: input.toolName },
    info: {
      toolSet: input.toolSet ?? makeMockIMCPServer({ name: 'web', preload: false }),
      originalToolName: input.toolName,
    },
    screen: undefined,
    failure: false,
    isStructuredContent: false,
    completedAt: new Date().toISOString(),
    memoized: false,
    repeatCount: 0,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'executed_ok',
    remediation: undefined,
    admissionProvenance: { source: 'automatic' },
  };
}

const EXECUTION: Readonly<AgentThreadExecutionContext> = {
  threadId: 'thread-1',
  currentContextUsage: getEmptyCurrentContextUsage(),
  context: [],
};

describe('page budget', () => {
  it('leaves a page under the budget unchanged', () => {
    const text = 'A short page.\n\nOne more paragraph.';
    expect(budgetPageText({ text, request: NO_REQUEST, maxTokens: PAGE_READ_TOKEN_BUDGET })).toBe(text);
  });

  it('keeps headings and the first paragraph under each, and drops the rest with a note', () => {
    const page = longPage(40);
    const shortened = budgetPageText({ text: page, request: NO_REQUEST, maxTokens: PAGE_READ_TOKEN_BUDGET });

    expect(estimateTokensForString(shortened)).toBeLessThanOrEqual(PAGE_READ_TOKEN_BUDGET + 60);
    expect(shortened).toContain('## Section 0');
    expect(shortened).toContain('lead-0');
    expect(shortened).not.toContain('tail-0');
    expect(shortened).toMatch(
      /\(Only part of this page is shown: about \d+ more tokens were left out, and no tool can show them\.\)$/,
    );
  });

  it('keeps a paragraph that mentions a word from the request, even when it is not a lead paragraph', () => {
    // Twelve sections leave room after the headings for one requested paragraph within the budget.
    const page = longPage(12).replace(
      paragraph('tail-7'),
      `${paragraph('tail-7')} The opening hours are nine to five.`,
    );
    const shortened = budgetPageText({
      text: page,
      request: new Set(['opening', 'hours']),
      maxTokens: PAGE_READ_TOKEN_BUDGET,
    });

    expect(shortened).toContain('The opening hours are nine to five.');
    expect(shortened).not.toContain('tail-3');
  });
});

describe('search budget', () => {
  function search(count: number): string {
    return JSON.stringify({
      schema_version: 'tool.response.v2',
      result: {
        results: Array.from({ length: count }, (_, index) => ({
          url: `https://example.com/${String(index)}`,
          title: `Result ${String(index)}`,
          excerpts: [`snippet ${String(index)} `.repeat(60)],
        })),
      },
    });
  }

  it('shows at most five of forty results, each with a title, a link and a short snippet', () => {
    const rendered = renderWebSearchResultsMarkdown(search(40));

    expect(rendered).toBeDefined();
    const entries = rendered?.split('\n\n').filter(block => /^\d+\. /.test(block)) ?? [];
    expect(entries).toHaveLength(5);
    expect(rendered).toContain('40 results, showing 5');
    for (const entry of entries) {
      const [title, link, snippet] = entry.split('\n').map(line => line.trim());
      expect(title).toMatch(/^\d+\. Result \d+$/);
      expect(link).toMatch(/^https:\/\/example\.com\/\d+$/);
      expect(snippet?.length ?? 0).toBeLessThanOrEqual(201);
    }
  });
});

describe('extract budget', () => {
  it('trims each page text in a Tavily extract result and keeps the JSON shape', async () => {
    const pages = [
      { url: 'https://guide.example.com/a', title: 'A', fetched_at: '2026-10-22T07:00:00.000Z', text: longPage(40) },
      { url: 'https://guide.example.com/b', title: 'B', fetched_at: '2026-10-22T07:00:00.000Z', text: 'Short page.' },
    ];
    const content = JSON.stringify({
      untrusted_web_text: true,
      notice: 'n',
      credits_estimate: 1,
      pages,
      not_fetched: [],
    });
    const result = toolResult({ content, toolName: TAVILY_EXTRACT_TOOL_NAME });

    await new IngestionBudgetProcessor().process([result], EXECUTION);

    const parsed: { pages: { url: string; text: string }[]; not_fetched: unknown[] } = JSON.parse(
      result.message.content,
    );
    expect(parsed.pages).toHaveLength(2);
    expect(estimateTokensForString(parsed.pages[0]?.text ?? '')).toBeLessThanOrEqual(PAGE_READ_TOKEN_BUDGET + 60);
    expect(parsed.pages[0]?.text).toContain('Only part of this page is shown:');
    expect(parsed.pages[1]?.text).toBe('Short page.');
    expect(parsed.not_fetched).toEqual([]);
  });
});

describe('page budget keeps the opening text', () => {
  it('keeps the title, the link and the opening text of a long page with no headings or blank lines', () => {
    const page = [
      'Harbour Guide: https://guide.example.com/harbour',
      'The harbour opens at dawn and closes at dusk. '.repeat(600),
    ].join(' ');
    const shortened = budgetPageText({ text: page, request: NO_REQUEST, maxTokens: PAGE_READ_TOKEN_BUDGET });

    expect(estimateTokensForString(shortened)).toBeLessThanOrEqual(PAGE_READ_TOKEN_BUDGET + 60);
    expect(shortened.startsWith('Harbour Guide: https://guide.example.com/harbour')).toBe(true);
    expect(shortened).toContain('Only part of this page is shown');
  });

  it('keeps the leading paragraph of a page with no headings', () => {
    const page = [paragraph('lead'), paragraph('second'), paragraph('third'), paragraph('fourth')].join('\n\n');
    const shortened = budgetPageText({ text: page, request: NO_REQUEST, maxTokens: PAGE_READ_TOKEN_BUDGET });

    expect(shortened.startsWith('lead ')).toBe(true);
  });
});

describe('sandbox budget', () => {
  function execResult(lines: number): string {
    return JSON.stringify({
      status: 'exited',
      exit_code: 3,
      response: {
        exitCode: 3,
        result: Array.from({ length: lines }, (_, index) => `out ${String(index)}`).join('\n'),
      },
    });
  }

  it('keeps the first and last forty lines of a long exec result and always keeps the exit code', () => {
    const trimmed = budgetSandboxOutput(execResult(500));
    expect(trimmed).toBeDefined();
    const parsed: { exit_code: number; response: { exitCode: number; result: string } } = JSON.parse(trimmed ?? '{}');

    expect(parsed.exit_code).toBe(3);
    expect(parsed.response.exitCode).toBe(3);
    const lines = parsed.response.result.split('\n');
    expect(lines.slice(0, SANDBOX_OUTPUT_EDGE_LINES)[0]).toBe('out 0');
    expect(lines.at(-1)).toBe('out 499');
    expect(parsed.response.result).toContain('420 lines left out');
    expect(parsed.response.result).toContain('output.head_lines, output.tail_lines or output.grep');
  });

  it('trims a long exec result through the ingestion pass, which runs on the sandbox tool set', async () => {
    const sandbox = makeStubPublicSandbox();
    const result = toolResult({ content: execResult(500), toolName: 'exec', toolSet: sandbox });

    await new IngestionBudgetProcessor().process([result], { ...EXECUTION, sandbox });

    expect(result.message.content).toContain('420 lines left out');
  });

  it('keeps the first and last forty lines of long run_code stdout and says the rest is not available', () => {
    const trimmed = budgetSandboxOutput(
      JSON.stringify({ status: 'exited', exit_code: 0, stdout: 'x\n'.repeat(200), stderr: '' }),
    );
    const parsed: { exit_code: number; stdout: string } = JSON.parse(trimmed ?? '{}');

    expect(parsed.exit_code).toBe(0);
    expect(parsed.stdout).toContain('The other lines are not available from this result.');
  });

  it('leaves output of eighty lines or fewer unchanged', () => {
    expect(budgetSandboxOutput(execResult(80))).toBeUndefined();
  });
});

describe('results that must reach the model whole are never shortened', () => {
  it('leaves a large get_space result unchanged, so a write cannot send back a shortened body', async () => {
    const body = longPage(60);
    const content = JSON.stringify({
      space: { id: 'space_1', name: 'Spain house search', revision: 4, body },
      aggregate_revision: 9,
    });
    const result = toolResult({
      content,
      toolName: 'get_space',
      toolSet: makeMockIMCPServer({ name: SPACE_SERVER_ID, preload: false }),
    });

    await new IngestionBudgetProcessor().process([result], EXECUTION);

    expect(result.message.content).toBe(content);
  });

  it('leaves a 25-event calendar list unchanged, so no page token can skip events', async () => {
    const events = Array.from({ length: 25 }, (_, index) => ({ id: `e${String(index)}` }));
    const content = JSON.stringify({ count: 25, events, next_page_token: 'token-after-25' });
    const result = toolResult({
      content,
      toolName: 'list_events',
      toolSet: makeMockIMCPServer({ name: CALENDAR_SERVER_ID, preload: false }),
    });

    await new IngestionBudgetProcessor().process([result], EXECUTION);

    expect(result.message.content).toBe(content);
  });
});

describe('maps grounding sees the full fetched page, not the budgeted result', () => {
  const scope = { tenant_id: 'tenant-1', conversation_id: 'chat-1' };
  const url = 'https://guide.example.com/markets';
  const placeName = 'Harbor Fresh Market';
  const placeAddress = '14 Quay Lane';

  /** A long guide whose only mention of the place sits in a paragraph the budget drops. */
  function guideWithPlace(): string {
    // The store keeps the first FETCHED_PAGE_TEXT_MAX_CHARS characters, so the place sits inside that window.
    const before = longPage(5);
    const placeParagraph = `${placeName} is at ${placeAddress}. ${'Stalls open at dawn with fruit and fish. '.repeat(4)}`;
    return `${before}\n\n${placeParagraph}\n\n${longPage(30)}`;
  }

  it('grounds a place from the recorded page after the model-facing text was shortened', async () => {
    const page = guideWithPlace();
    const pages = new FetchedPageStore({ now: () => Date.now(), ttlMs: 60_000, maxPages: 10 });
    recordFetchedPages({
      pages,
      scope,
      toolArguments: { url },
      texts: [page],
    });

    const result = toolResult({ content: page, toolName: 'web_fetch' });
    await new IngestionBudgetProcessor().process([result], EXECUTION);

    expect(result.message.content).not.toContain(placeName);

    const grounded = groundPlace({
      claim: {
        name: placeName,
        address: placeAddress,
        languages: null,
        hours: null,
        price: null,
        phone: null,
        source_url: url,
      },
      pages,
      scope,
    });
    expect(grounded.ok).toBe(true);
  });
});
