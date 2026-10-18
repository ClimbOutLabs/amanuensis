import { Writable } from 'node:stream';
import type { Logger } from 'winston';
import { createLogger, format, transports } from 'winston';
import type { AgentThreadExecutionContext } from '../../../../src/core/capabilities/AgentContextProcessor';
import {
  LargeToolResponseProcessor,
  SANDBOX_LARGE_OUTPUT_HEAD_CHARS,
  jsonStructuralSummary,
} from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import type { IToolSet } from '../../../../src/core/mcp/IMCPServer';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import type { Sandbox } from '../../../../src/core/sandbox/Sandbox';
import type { ToolOutputScreenDecision } from '../../../../src/schemas/toolOutputScreen';
import { makeMockIMCPServer, makeSilentLogger, makeStubPublicSandbox } from '../../harnessMocks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsedSummary(result: ToolCallResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.message.content);
  if (!isRecord(parsed)) {
    throw new Error('expected the replaced content to be a JSON object summary');
  }
  return parsed;
}

function makeCapturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
      warnings.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    level: 'warn',
    format: format.simple(),
    transports: [new transports.Stream({ stream })],
  });
  return { logger, warnings };
}

describe('jsonStructuralSummary', () => {
  it('returns undefined for non-JSON content', () => {
    expect(jsonStructuralSummary('not json')).toBeUndefined();
  });

  it('returns undefined for a JSON scalar with no structure to summarize', () => {
    expect(jsonStructuralSummary('42')).toBeUndefined();
    expect(jsonStructuralSummary('"a string"')).toBeUndefined();
  });

  it('summarizes top-level keys, array lengths, and the first two items of the largest array', () => {
    const payload = {
      status: 'ok',
      items: Array.from({ length: 5 }, (_, index) => ({ id: index, name: `item-${String(index)}` })),
      tags: ['a', 'b'],
    };

    const summary = jsonStructuralSummary(JSON.stringify(payload));

    expect(summary).toBeDefined();
    expect(summary).toContain('Top-level keys: status, items, tags');
    expect(summary).toContain('items: array, length 5');
    expect(summary).toContain('tags: array, length 2');
    // items is the largest array — its first two entries are rendered, not tags'.
    expect(summary).toContain('First 2 item(s) of items:');
    expect(summary).toContain('"id": 0');
    expect(summary).toContain('"id": 1');
    expect(summary).not.toContain('"id": 2');
  });

  it('summarizes a top-level array root directly', () => {
    const payload = Array.from({ length: 3 }, (_, index) => ({ index }));

    const summary = jsonStructuralSummary(JSON.stringify(payload));

    expect(summary).toBeDefined();
    expect(summary).toContain('Top-level: array, length 3');
    expect(summary).toContain('First 2 item(s) of (root array):');
  });

  it('bounds the summary to about 60 lines', () => {
    const payload = {
      items: Array.from({ length: 50 }, (_, index) => ({
        id: index,
        description: 'x'.repeat(200),
      })),
    };

    const summary = jsonStructuralSummary(JSON.stringify(payload));

    expect(summary).toBeDefined();
    const lineCount = summary?.split('\n').length ?? 0;
    expect(lineCount).toBeLessThanOrEqual(60);
  });

  it('bounds a single oversized sampled value instead of emitting it whole', () => {
    // A single huge value inside the first sampled item must not defeat the
    // large-output guard: the 60-line cap alone does not bound total size,
    // since one array item can serialize to a single very long line.
    const payload = { items: ['x'.repeat(1_000_000)] };

    const summary = jsonStructuralSummary(JSON.stringify(payload));

    expect(summary).toBeDefined();
    expect(summary?.length).toBeLessThan(5000);
    expect(summary).toContain('truncated');
  });

  it('bounds a single oversized top-level key name instead of emitting it whole', () => {
    const payload = { ['k'.repeat(1_000_000)]: 'value' };

    const summary = jsonStructuralSummary(JSON.stringify(payload));

    expect(summary).toBeDefined();
    expect(summary?.length).toBeLessThan(5000);
  });
});

describe('LargeToolResponseProcessor', () => {
  interface McpResultOptions {
    content: string;
    originalToolName: string;
    toolSet: IToolSet;
    serverId?: string | undefined;
    failure?: boolean | undefined;
    screen?: ToolOutputScreenDecision | undefined;
  }

  function makeMcpResult(options: McpResultOptions): ToolCallResult {
    const serverId = options.serverId ?? 'test-server';
    return {
      message: { role: 'tool', tool_call_id: 'test-id', content: options.content },
      rawContent: options.content,
      images: [],
      toolCallInfo: {
        type: 'mcp',
        mcp_server_id: serverId,
        mcp_server_name: serverId,
        original_tool_name: options.originalToolName,
      },
      screen: options.screen,
      info: { toolSet: options.toolSet, originalToolName: options.originalToolName },
      failure: options.failure ?? false,
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

  function makeProcessor(logger?: Logger): LargeToolResponseProcessor {
    return new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 1000,
      totalTokenThreshold: 2000,
      previewNumberOfCharacters: 100,
      logger: logger ?? makeSilentLogger(),
    });
  }

  async function processMcpResults(input: {
    results: ToolCallResult[];
    sandbox?: Sandbox | undefined;
    logger?: Logger | undefined;
  }): Promise<void> {
    const execution: Readonly<AgentThreadExecutionContext> = {
      threadId: 'thread-1',
      sandbox: input.sandbox,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    };
    await makeProcessor(input.logger).process(input.results, execution);
  }

  /** Roughly 330 serialized bytes per item: big enough to trip the 1000-token threshold fast. */
  function bigItemsJson(count: number): string {
    return JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        id: `item-${String(index)}`,
        body: `payload-${String(index)}-`.padEnd(300, 'x'),
      })),
    );
  }

  describe('sandbox category', () => {
    function makeSandboxResult(content: string, sandbox: Sandbox): ToolCallResult {
      return makeMcpResult({ content, originalToolName: 'exec', toolSet: sandbox });
    }

    it('replaces large sandbox output with bounded head', async () => {
      const sandbox = makeStubPublicSandbox();
      const largeOutput = Array.from({ length: 1000 }, (_, i) => `line ${String(i)}`).join('\n');
      const result = makeSandboxResult(largeOutput, sandbox);

      await processMcpResults({ results: [result], sandbox });

      expect(result.message.content).toContain('The Agent has seen only the first');
      expect(result.message.content).toContain('of this output; the rest was not seen');
      expect(result.message.content).toContain('Head:');
      expect(result.outputTransform).toBe('replaced');
    });

    it('cuts bounded head on line boundary', async () => {
      const sandbox = makeStubPublicSandbox();
      const lineCount = 1000;
      const lines = Array.from({ length: lineCount }, (_, i) => `line ${String(i)}`);
      const largeOutput = lines.join('\n');
      const result = makeSandboxResult(largeOutput, sandbox);

      await processMcpResults({ results: [result], sandbox });

      const content = result.message.content;
      const headMatch = content.match(/Head:\n([\s\S]+)$/);
      expect(headMatch).toBeDefined();
      const head = headMatch?.[1];
      expect(head).toBeDefined();
      if (head) {
        const headLines = head.trimEnd().split('\n');
        expect(headLines.length).toBeGreaterThan(1);
        expect(headLines[0]).toMatch(/^line \d+$/);
      }
    });

    it('includes exact line and character counts in the message', async () => {
      const sandbox = makeStubPublicSandbox();
      const lineCount = 500;
      const lines = Array.from({ length: lineCount }, (_, i) => `output line ${String(i)}`);
      const largeOutput = lines.join('\n');
      const result = makeSandboxResult(largeOutput, sandbox);

      await processMcpResults({ results: [result], sandbox });

      const content = result.message.content;
      expect(content).toContain(`of ${String(lineCount)} lines`);
      expect(content).toContain(`of ${String(largeOutput.length)} characters`);
    });
  });

  describe('mcp category', () => {
    it('replaces an oversized JSON array with a bounded complete-item summary', async () => {
      const content = bigItemsJson(30);
      const result = makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() });

      await processMcpResults({ results: [result] });

      const summary = parsedSummary(result);
      expect(summary['result_kind']).toBe('collection');
      const items = summary['items'];
      expect(Array.isArray(items)).toBe(true);
      if (!Array.isArray(items)) {
        throw new Error('unreachable');
      }
      expect(items).toHaveLength(30);
      for (const item of items) {
        // Complete values only: every item carries both fields, never severed mid-object.
        expect(item).toMatchObject({ id: expect.any(String), body: expect.any(String) });
      }
      // No source-reported denominator: the total stays explicitly unknown, never guessed.
      expect(summary['total_count']).toBeNull();
      expect(summary['items_seen']).toBe(30);
      expect(summary['items_extracted']).toBe(30);
      expect(summary['unseen_count']).toBeNull();
      expect(summary['screened_out']).toBe(0);
      expect(summary['truncated']).toBe(false);
      expect(result.outputTransform).toBe('replaced');
      // The screen classifier must see the original bytes, never the projection.
      expect(result.rawContent).toBe(content);
    });

    it('truncates at complete-item boundaries and reports total unknown honestly', async () => {
      const content = bigItemsJson(200);
      const { logger, warnings } = makeCapturingLogger();
      const result = makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() });

      await processMcpResults({ results: [result], logger });

      const summary = parsedSummary(result);
      const items = summary['items'];
      expect(Array.isArray(items)).toBe(true);
      if (!Array.isArray(items)) {
        throw new Error('unreachable');
      }
      expect(items).toHaveLength(50);
      for (const item of items) {
        expect(item).toMatchObject({ id: expect.any(String), body: expect.any(String) });
      }
      expect(summary['total_count']).toBeNull();
      expect(summary['items_seen']).toBe(200);
      expect(summary['items_extracted']).toBe(50);
      expect(summary['unseen_count']).toBeNull();
      expect(summary['truncated']).toBe(true);
      expect(summary['unseen_statement']).toContain('Total unknown');
      expect(summary['unseen_statement']).toContain('150 parsed items were not shown and were not seen');
      // No fetch-semantics entry names a re-fetch: the continuation is an explicit dead end.
      expect(summary['next']).toContain('No re-fetch path is available');
      // ...and the tripwire fires so the gap is visible for product review.
      expect(warnings.join('\n')).toContain('no re-fetch path');
    });

    it('measures bytes as UTF-8, not UTF-16 code units', async () => {
      const content = JSON.stringify(
        Array.from({ length: 30 }, (_, index) => ({ id: index, text: '日本語テスト🎉'.repeat(20) })),
      );
      const result = makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() });

      await processMcpResults({ results: [result] });

      const summary = parsedSummary(result);
      const expectedBytes = new TextEncoder().encode(content).length;
      expect(expectedBytes).toBeGreaterThan(content.length);
      expect(summary['total_bytes']).toBe(expectedBytes);
    });

    it('takes the panic path beyond the parse ceiling and logs a content-free fingerprint', async () => {
      const content = JSON.stringify('x'.repeat(1_200_000));
      const { logger, warnings } = makeCapturingLogger();
      const result = makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() });

      await processMcpResults({ results: [result], logger });

      expect(result.message.content).toContain('The Agent has not seen this tool result');
      expect(result.message.content).toContain('Preview (first and last 100 chars)');
      expect(result.outputTransform).toBe('replaced');
      const logged = warnings.join('\n');
      expect(logged).toContain('not summarizable');
      expect(logged).toMatch(/list_items:len=\d+:prefix=[0-9a-f]+/);
      expect(logged).not.toContain('x'.repeat(64));
    });

    it('routes an unrecognized tool with large text through the generic text fallback, not panic', async () => {
      const content = `Log output from list_items:\n${'a readable log line with several words in it\n'.repeat(1200)}`;
      const result = makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() });

      await processMcpResults({ results: [result] });

      // Structured excerpt via the generic text fallback — not the panic path.
      expect(result.message.content).not.toContain('has not seen this tool result');
      expect(result.outputTransform).toBe('replaced');
      const summary = parsedSummary(result);
      expect(summary['result_kind']).toBe('text');
      expect(summary['text_excerpt']).toContain('a readable log line');
      expect(summary['unseen_statement']).toContain('from list_items');
      expect(summary['unseen_statement']).toContain('narrower parameters');
      // The full 50k+ body is not smuggled through.
      expect(result.message.content.length).toBeLessThan(content.length);
      // The screen classifier must see the original bytes, never the projection.
      expect(result.rawContent).toBe(content);
    });

    it('takes the panic path for a binary blob from an unrecognized tool', async () => {
      const content = '\x00\x01\x02\x03'.repeat(4000);
      const { logger, warnings } = makeCapturingLogger();
      const result = makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() });

      await processMcpResults({ results: [result], logger });

      expect(result.message.content).toContain('has not seen this tool result');
      expect(result.outputTransform).toBe('replaced');
      expect(warnings.join('\n')).toContain('not summarizable');
    });

    it('leaves results below the thresholds untouched', async () => {
      const result = makeMcpResult({
        content: 'small',
        originalToolName: 'list_items',
        toolSet: makeStubPublicSandbox(),
      });

      await processMcpResults({ results: [result] });

      expect(result.message.content).toBe('small');
      expect(result.outputTransform).toBeUndefined();
    });

    it('blocks the largest sub-threshold results when the batch total exceeds the total threshold', async () => {
      // 750 tokens each: under the 1000-token individual bar, but three of
      // them total 2250 tokens, over the 2000-token batch bar. Binary blobs
      // take the panic path (bounded preview), which actually shrinks, so the
      // guard trims the largest one back under the bar.
      const contents = ['\x00\x01'.repeat(1500), '\x00\x02'.repeat(1500), '\x00\x03'.repeat(1500)];
      const results = contents.map(content =>
        makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() }),
      );

      await processMcpResults({ results });

      const replaced = results.filter(entry => entry.outputTransform === 'replaced');
      expect(replaced).toHaveLength(1);
      expect(results[0]?.outputTransform).toBe('replaced');
      expect(results[1]?.message.content).toBe(contents[1]);
      expect(results[2]?.message.content).toBe(contents[2]);
    });

    it('leaves sub-threshold text results untouched when the excerpt would not shrink them', async () => {
      // 750 tokens each: under the 1000-token individual bar, three total 2250
      // tokens, over the 2000-token batch bar. But the generic text fallback's
      // framed excerpt (~950 tokens) is larger than the original, so replacing
      // would inflate the batch total the guard exists to shrink. The guard
      // must leave these alone rather than "reduce" by growing.
      const contents = ['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(3000)];
      const results = contents.map(content =>
        makeMcpResult({ content, originalToolName: 'list_items', toolSet: makeStubPublicSandbox() }),
      );

      await processMcpResults({ results });

      for (const [index, entry] of results.entries()) {
        expect(entry.outputTransform).toBeUndefined();
        expect(entry.message.content).toBe(contents[index]);
      }
    });

    it('leaves a screen-withheld result untouched and never counts it as seen', async () => {
      const content = bigItemsJson(30);
      const result = makeMcpResult({
        content,
        originalToolName: 'list_items',
        toolSet: makeStubPublicSandbox(),
        screen: { status: 'flagged', action: 'withheld', reason_code: 'classifier_malicious', score: 0.99 },
      });

      await processMcpResults({ results: [result] });

      expect(result.message.content).toBe(content);
      expect(result.outputTransform).toBeUndefined();
      expect(result.rawContent).toBe(content);
    });

    it('summarizes normally when the screen passed the result', async () => {
      const content = bigItemsJson(30);
      const result = makeMcpResult({
        content,
        originalToolName: 'list_items',
        toolSet: makeStubPublicSandbox(),
        screen: { status: 'passed', action: 'admitted', reason_code: 'classifier_benign', score: 0.01 },
      });

      await processMcpResults({ results: [result] });

      expect(parsedSummary(result)['result_kind']).toBe('collection');
    });
  });
});

describe('bounded head function', () => {
  it('exports SANDBOX_LARGE_OUTPUT_HEAD_CHARS constant', () => {
    expect(SANDBOX_LARGE_OUTPUT_HEAD_CHARS).toBe(6_000);
  });
});

describe('oversized MCP results (email fetch semantics)', () => {
  function makeMcpResult(toolName: string, content: string, screen?: ToolCallResult['screen']): ToolCallResult {
    return {
      message: { role: 'tool', tool_call_id: `call-${toolName}`, content },
      rawContent: content,
      images: [],
      toolCallInfo: undefined,
      screen,
      info: {
        toolSet: makeMockIMCPServer({ name: 'gmail-mcp', preload: false }),
        originalToolName: toolName,
      },
      failure: false,
      isStructuredContent: false,
      completedAt: new Date().toISOString(),
      memoized: false,
      repeatCount: 0,
      blockedPrivateFallback: false,
      repeatedSideEffect: false,
      verificationReceiptCandidate: undefined,
      disposition: 'never_ran',
      remediation: undefined,
      admissionProvenance: { source: 'automatic' },
    };
  }

  async function processMcpResults(results: ToolCallResult[], logger?: Logger): Promise<void> {
    const processor = new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 1000,
      totalTokenThreshold: 2000,
      previewNumberOfCharacters: 100,
      logger: logger ?? makeSilentLogger(),
    });
    const execution: Readonly<AgentThreadExecutionContext> = {
      threadId: 'thread-1',
      sandbox: undefined,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    };
    await processor.process(results, execution);
  }

  function bigThreadJson(messageCount: number, bodyChars: number): string {
    const messages = Array.from({ length: messageCount }, (_, index) => ({
      messageId: `msg-${String(index)}`,
      threadId: 'thread-1',
      from: 'a@example.com',
      to: 'b@example.com',
      cc: '',
      bcc: '',
      subject: `Re: Subject ${String(index)}`,
      date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      body: 'confidential-body-text '.repeat(bodyChars),
      labelIds: ['INBOX'],
      attachments: [],
    }));
    return JSON.stringify({
      threadId: 'thread-1',
      messageCount,
      messages,
      truncated: false,
      total_available: messageCount,
    });
  }

  it('replaces an oversized get_thread with a metadata-first summary', async () => {
    const raw = bigThreadJson(40, 40);
    const result = makeMcpResult('get_thread', raw);

    await processMcpResults([result]);

    expect(result.message.content).not.toContain('confidential-body-text');
    expect(result.message.content).toContain('msg-0');
    expect(parsedSummary(result)['next']).toContain('get_thread(threadId="thread-1", format="metadata")');
    expect(result.message.content).toContain('metadata_only');
    expect(result.outputTransform).toBe('replaced');
    // rawContent stays intact for output screening.
    expect(result.rawContent).toBe(raw);
  });

  it('continues an oversized search_emails by restarting (not using the token)', async () => {
    const results = Array.from({ length: 80 }, (_, index) => ({
      id: `msg-${String(index)}`,
      threadId: `thread-${String(index)}`,
      subject: `Subject ${String(index)}`,
      from: `sender${String(index)}@example.com`,
      fromAddress: { name: `S${String(index)}`, email: `sender${String(index)}@example.com` },
      to: [],
      cc: [],
      date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      snippet: 'x'.repeat(200),
    }));
    const raw = JSON.stringify({
      resultCount: 80,
      results,
      nextPageToken: 'real-token-123',
      resultSizeEstimate: 500,
      truncated: true,
      total_available: 500,
    });
    const result = makeMcpResult('search_emails', raw);

    await processMcpResults([result]);

    // 80 items > 50 summary cap: using the token would orphan items 51-80.
    // Continuation must instruct to restart from the beginning, not use token.
    expect(parsedSummary(result)['next']).not.toContain('pageToken="real-token-123"');
    expect(parsedSummary(result)['next']).toContain('maxResults=10');
    expect(result.message.content).toContain('server estimate');
    expect(result.outputTransform).toBe('replaced');
  });

  it('leaves a small search_emails result untouched', async () => {
    const raw = JSON.stringify({ resultCount: 1, results: [{ id: 'm1' }], truncated: false, total_available: 1 });
    const result = makeMcpResult('search_emails', raw);

    await processMcpResults([result]);

    expect(result.message.content).toBe(raw);
    expect(result.outputTransform).toBeUndefined();
  });

  it('takes the panic path for an unsummarizable email blob and logs a content-free fingerprint', async () => {
    const { logger, warnings } = makeCapturingLogger();
    // Truncated JSON: parses fail, so nothing can be accounted for. The
    // secret sits mid-blob so the bounded head/tail preview cannot leak it.
    const raw =
      `{"messages": [{"messageId": "m1", "a": "${'x'.repeat(20000)}", ` +
      `"body": "confidential-body-text", "b": "${'y'.repeat(20000)}"`;
    const result = makeMcpResult('get_thread', raw);

    await processMcpResults([result], logger);

    expect(result.message.content).toContain('has not seen this tool result');
    expect(result.message.content).toContain('Preview (first and last 100 chars)');
    expect(result.message.content).not.toContain('confidential-body-text');
    const logged = warnings.join('\n');
    expect(logged).toContain('get_thread');
    expect(logged).not.toContain('confidential-body-text');
    expect(result.rawContent).toBe(raw);
  });

  it('summarizes an oversized read_email metadata-only with no re-fetch path', async () => {
    const bodyText = `first line\n${'confidential '.repeat(3000)}`;
    const raw = JSON.stringify({
      messageId: 'msg-1',
      threadId: 'thread-1',
      subject: 'Big',
      from: 'a@example.com',
      to: 'b@example.com',
      cc: '',
      bcc: '',
      date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      rfcMessageId: '<x@y>',
      body: bodyText,
      bodyText,
      bodyHtml: `<p>${bodyText}</p>`,
      attachments: [],
    });
    const result = makeMcpResult('read_email', raw);

    await processMcpResults([result]);

    expect(result.message.content).not.toContain('confidential');
    expect(result.message.content).toContain('first line');
    expect(result.message.content).toContain('metadata_and_body_excerpt');
    expect(result.message.content).toContain('no intra-body paging');
  });

  it('labels a read_email excerpt honestly: metadata plus the body head that was actually seen', async () => {
    const bodyText = `first line\n${'confidential '.repeat(3000)}`;
    const raw = JSON.stringify({
      messageId: 'msg-1',
      threadId: 'thread-1',
      subject: 'Big',
      from: 'a@example.com',
      to: 'b@example.com',
      cc: '',
      bcc: '',
      date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      rfcMessageId: '<x@y>',
      body: bodyText,
      bodyText,
      bodyHtml: `<p>${bodyText}</p>`,
      attachments: [],
    });
    const result = makeMcpResult('read_email', raw);

    await processMcpResults([result]);

    const summary = parsedSummary(result);
    expect(summary['seen']).toBe('metadata_and_body_excerpt');
    expect(summary['honesty_note']).toContain('first');
    expect(summary['honesty_note']).toContain('characters of the message body');
    expect(summary['honesty_note']).toContain('was stripped by the host and was not seen');
    // The excerpt is bounded and cut at a line boundary; the tail is not shown.
    const excerpt = summary['text_excerpt'];
    expect(typeof excerpt).toBe('string');
    if (typeof excerpt !== 'string') {
      throw new Error('unreachable');
    }
    expect(excerpt.length).toBeLessThanOrEqual(4000);
    expect(bodyText.startsWith(excerpt)).toBe(true);
    expect(summary['chars_total']).toBe(bodyText.length);
    // Single-item results have no intra-item paging: an explicit dead end, not a guess.
    expect(summary['next']).toContain('No re-fetch path is available');
  });

  it('reports total_bytes from the original result, not the sanitized projection', async () => {
    const raw = bigThreadJson(40, 40);
    const result = makeMcpResult('get_thread', raw);

    await processMcpResults([result]);

    const summary = parsedSummary(result);
    const expectedBytes = new TextEncoder().encode(raw).length;
    expect(summary['total_bytes']).toBe(expectedBytes);
    // The sanitized metadata actually shown is far smaller than the original.
    expect(JSON.stringify(summary['items']).length).toBeLessThan(expectedBytes / 2);
  });

  it('fails closed to the generic summary when a same-named tool result does not fit the email shape', async () => {
    // search_emails on some other server: results exist but carry no usable id.
    const raw = JSON.stringify({ results: Array.from({ length: 40 }, (_, i) => ({ n: i, v: 'x'.repeat(500) })) });
    const { logger, warnings } = makeCapturingLogger();
    const result = makeMcpResult('search_emails', raw);

    await processMcpResults([result], logger);

    // No invented ids, no email continuation: the generic bounded summary.
    expect(result.message.content).not.toContain('read_email(messageId=');
    const summary = parsedSummary(result);
    expect(summary['result_kind']).toBe('collection');
    expect(summary['host_transform']).toBeUndefined();
    expect(warnings.join('\n')).toContain('missed its fetch-semantics shape');
  });

  it('continues get_inbox_with_threads with an exact nested read_email call', async () => {
    const raw = JSON.stringify({
      resultCount: 1,
      threads: [
        {
          threadId: 'thread-1',
          messageCount: 1,
          messages: [
            {
              messageId: 'nested-1',
              threadId: 'thread-1',
              subject: 'Hi',
              body: 'confidential-body-text '.repeat(2000),
            },
          ],
        },
      ],
      truncated: false,
      total_available: 1,
    });
    const result = makeMcpResult('get_inbox_with_threads', raw);

    await processMcpResults([result]);

    expect(result.message.content).not.toContain('confidential-body-text');
    expect(parsedSummary(result)['next']).toBe('Fetch any full message with read_email(messageId="nested-1").');
  });

  it('never invents a read_email call when nested message ids are missing', async () => {
    const raw = JSON.stringify({
      resultCount: 1,
      threads: [
        {
          threadId: 'thread-1',
          messageCount: 1,
          messages: [{ threadId: 'thread-1', subject: 'Hi', body: 'confidential-body-text '.repeat(2000) }],
        },
      ],
      truncated: false,
      total_available: 1,
    });
    const result = makeMcpResult('get_inbox_with_threads', raw);

    await processMcpResults([result]);

    // Falls back to the generic bounded summary: no invented message id.
    expect(result.message.content).not.toContain('read_email(messageId=');
    expect(result.message.content).not.toContain('confidential-body-text');
  });
});

describe('oversized MCP results (email text shape, structuredContent absent)', () => {
  function makeMcpResult(toolName: string, content: string): ToolCallResult {
    return {
      message: { role: 'tool', tool_call_id: `call-${toolName}`, content },
      rawContent: content,
      images: [],
      toolCallInfo: undefined,
      screen: undefined,
      info: {
        toolSet: makeMockIMCPServer({ name: 'gmail-mcp', preload: false }),
        originalToolName: toolName,
      },
      failure: false,
      isStructuredContent: false,
      completedAt: new Date().toISOString(),
      memoized: false,
      repeatCount: 0,
      blockedPrivateFallback: false,
      repeatedSideEffect: false,
      verificationReceiptCandidate: undefined,
      disposition: 'never_ran',
      remediation: undefined,
      admissionProvenance: { source: 'automatic' },
    };
  }

  async function processMcpResults(results: ToolCallResult[], logger?: Logger): Promise<void> {
    const processor = new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 1000,
      totalTokenThreshold: 2000,
      previewNumberOfCharacters: 100,
      logger: logger ?? makeSilentLogger(),
    });
    const execution: Readonly<AgentThreadExecutionContext> = {
      threadId: 'thread-1',
      sandbox: undefined,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    };
    await processor.process(results, execution);
  }

  // Real @george43g/gmail-mcp read_email text layout when structuredContent
  // is absent: headers, blank line, body. (dist/core/ops/messages.js)
  function bigReadEmailText(): string {
    const body =
      `We fly SFO to ORD to MAD on September 22, arriving September 23. The Petit Palace Santa Barbara is booked September 23 onward. ` +
      'x'.repeat(30000);
    return (
      `Thread ID: thread-abc\nMessage-ID: <msg123@mail.gmail.com>\nSubject: Spain trip dates\n` +
      `From: Robin <robin@example.com>\nTo: me@example.com\nDate: Mon, 21 Sep 2026 09:00:00 -0700\n\n${body}`
    );
  }

  it('gives the model a usable excerpt instead of the panic path for text-shaped read_email', async () => {
    const { logger, warnings } = makeCapturingLogger();
    const raw = bigReadEmailText();
    const result = makeMcpResult('read_email', raw);

    await processMcpResults([result], logger);

    // Not the panic path: the model saw something it can use.
    expect(result.message.content).not.toContain('has not seen this tool result');
    expect(result.outputTransform).toBe('replaced');
    // The Spain dates are extractable from the excerpt head.
    expect(result.message.content).toContain('September 22');
    expect(result.message.content).toContain('Subject: Spain trip dates');
    // Bounded: the full 30k body is not smuggled through.
    expect(result.message.content.length).toBeLessThan(raw.length);
    expect(result.message.content).toContain('no intra-body paging');
    // rawContent stays intact for output screening.
    expect(result.rawContent).toBe(raw);
    // Observable diagnostics, content-free.
    const logged = warnings.join('\n');
    expect(logged).toContain('read_email');
    expect(logged).not.toContain('Petit Palace');
  });

  it('gives pagination guidance for text-shaped search_emails', async () => {
    const block = `ID: msg-1\nSubject: Re: Spain hotels\nFrom: hotels@example.com\nDate: Mon, 21 Sep 2026 10:00:00 -0700\n\n`;
    const raw = block.repeat(500);
    const result = makeMcpResult('search_emails', raw);

    await processMcpResults([result]);

    expect(result.message.content).not.toContain('has not seen this tool result');
    expect(result.outputTransform).toBe('replaced');
    expect(result.message.content).toContain('ID: msg-1');
    expect(result.message.content).toContain('maxResults');
  });

  it('still takes the panic path for malformed JSON (fail-closed)', async () => {
    const { logger } = makeCapturingLogger();
    // Starts with `{` so it belongs to the JSON summarizer, which fails.
    const raw = `{"messages": [{"messageId": "m1", "body": "${'x'.repeat(20000)}"`;
    const result = makeMcpResult('get_thread', raw);

    await processMcpResults([result], logger);

    expect(result.message.content).toContain('has not seen this tool result');
  });
});
