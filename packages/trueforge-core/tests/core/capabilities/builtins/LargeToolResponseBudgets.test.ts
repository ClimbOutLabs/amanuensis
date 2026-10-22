import type { AgentThreadExecutionContext } from '../../../../src/core/capabilities/AgentContextProcessor';
import {
  budgetCalendarList,
  budgetPageText,
  budgetSandboxOutput,
  budgetSpaceRead,
  CALENDAR_LIST_EVENT_BUDGET,
  LargeToolResponseProcessor,
  PAGE_READ_TOKEN_BUDGET,
  SANDBOX_OUTPUT_EDGE_LINES,
  SPACE_READ_TOKEN_BUDGET,
} from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import { renderWebSearchResultsMarkdown } from '../../../../src/core/capabilities/builtins/WebSearchRendering';
import { estimateTokensForString } from '../../../../src/core/llm/usage';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { FetchedPageStore, recordFetchedPages } from '../../../../src/core/search/fetchedPages';
import { groundPlace } from '../../../../src/core/search/groundPlace';
import { makeMockIMCPServer, makeSilentLogger } from '../../harnessMocks';

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
    expect(shortened).toMatch(/\(shortened: \d+ more tokens; ask to read a named section to see more\)$/);
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

describe('sandbox budget', () => {
  function sandboxResult(lines: number): string {
    return JSON.stringify({
      status: 'exited',
      exit_code: 3,
      stdout: Array.from({ length: lines }, (_, index) => `out ${String(index)}`).join('\n'),
      stderr: '',
    });
  }

  it('keeps the first and last forty lines of long stdout and always keeps the exit code', () => {
    const trimmed = budgetSandboxOutput(sandboxResult(500));
    expect(trimmed).toBeDefined();
    const parsed: { exit_code: number; stdout: string } = JSON.parse(trimmed ?? '{}');

    expect(parsed.exit_code).toBe(3);
    const lines = parsed.stdout.split('\n');
    expect(lines.slice(0, SANDBOX_OUTPUT_EDGE_LINES)[0]).toBe('out 0');
    expect(lines.slice(0, SANDBOX_OUTPUT_EDGE_LINES)[SANDBOX_OUTPUT_EDGE_LINES - 1]).toBe('out 39');
    expect(lines.at(-1)).toBe('out 499');
    expect(lines.at(-SANDBOX_OUTPUT_EDGE_LINES)).toBe('out 460');
    expect(parsed.stdout).toContain('420 lines omitted');
  });

  it('leaves output of eighty lines or fewer unchanged', () => {
    expect(budgetSandboxOutput(sandboxResult(80))).toBeUndefined();
  });
});

describe('space read budget', () => {
  it('trims a long space body to the space budget by heading', () => {
    const body = longPage(60);
    const content = JSON.stringify({ space: { id: 'space_1' }, body });
    const trimmed = budgetSpaceRead({ content, request: NO_REQUEST });
    expect(trimmed).toBeDefined();

    const parsed: { body: string } = JSON.parse(trimmed ?? '{}');
    expect(estimateTokensForString(parsed.body)).toBeLessThanOrEqual(SPACE_READ_TOKEN_BUDGET + 60);
    expect(parsed.body).toContain('## Section 0');
    expect(parsed.body).toContain('shortened:');
  });
});

describe('calendar list budget', () => {
  it('keeps the first twenty events in order and counts the rest', () => {
    const events = Array.from({ length: 33 }, (_, index) => ({
      id: `e${String(index)}`,
      title: `Event ${String(index)}`,
    }));
    const trimmed = budgetCalendarList(JSON.stringify({ count: 33, events }));
    expect(trimmed).toBeDefined();

    const parsed: { count: number; events: { id: string }[]; events_omitted: number } = JSON.parse(trimmed ?? '{}');
    expect(parsed.events).toHaveLength(CALENDAR_LIST_EVENT_BUDGET);
    expect(parsed.events[0]?.id).toBe('e0');
    expect(parsed.events.at(-1)?.id).toBe('e19');
    expect(parsed.events_omitted).toBe(13);
    expect(parsed.count).toBe(33);
  });

  it('leaves a list of twenty events or fewer unchanged', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({ id: `e${String(index)}` }));
    expect(budgetCalendarList(JSON.stringify({ events }))).toBeUndefined();
  });
});

describe('maps grounding sees the full fetched page, not the budgeted result', () => {
  const scope = { tenant_id: 'tenant-1', conversation_id: 'chat-1' };
  const url = 'https://guide.example.com/markets';
  const placeName = 'Harbor Fresh Market';
  const placeAddress = '14 Quay Lane';

  /** A long guide whose only mention of the place sits in a paragraph the budget drops. */
  function guideWithPlace(): string {
    // The store keeps the first 8000 characters of a page, so the place must sit inside that window.
    const before = longPage(5);
    const placeParagraph = `${placeName} is at ${placeAddress}. ${'Stalls open at dawn with fruit and fish. '.repeat(4)}`;
    return `${before}\n\n${placeParagraph}\n\n${longPage(30)}`;
  }

  function fetchResult(content: string): ToolCallResult {
    return {
      message: { role: 'tool', tool_call_id: 'fetch-1', content },
      rawContent: content,
      images: [],
      toolCallInfo: { type: 'mcp', mcp_server_id: 'web', mcp_server_name: 'web', original_tool_name: 'web_fetch' },
      info: {
        toolSet: makeMockIMCPServer({ name: 'web', preload: false }),
        originalToolName: 'web_fetch',
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

  it('grounds a place from the recorded page after the model-facing text was shortened', async () => {
    const page = guideWithPlace();
    const pages = new FetchedPageStore({ now: () => Date.now(), ttlMs: 60_000, maxPages: 10 });
    recordFetchedPages({
      pages,
      scope,
      toolArguments: { url },
      texts: [page],
    });

    const result = fetchResult(page);
    const processor = new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 1000,
      totalTokenThreshold: 2000,
      previewNumberOfCharacters: 100,
      logger: makeSilentLogger(),
    });
    const execution: Readonly<AgentThreadExecutionContext> = {
      threadId: 'thread-1',
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    };
    await processor.process([result], execution);

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
