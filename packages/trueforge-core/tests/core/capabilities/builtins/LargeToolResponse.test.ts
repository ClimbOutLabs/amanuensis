import type { AgentThreadExecutionContext } from '../../../../src/core/capabilities/AgentContextProcessor';
import {
  LargeToolResponseProcessor,
  SANDBOX_LARGE_OUTPUT_HEAD_CHARS,
  jsonStructuralSummary,
} from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import type { LLMToolMessage } from '../../../../src/core/llm/LLMTypes';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { makeSilentLogger, makeStubPublicSandbox } from '../../harnessMocks';

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
  function makeToolCallResult(overrides: Partial<ToolCallResult> = {}): ToolCallResult {
    const defaultMessage = {
      role: 'tool',
      tool_call_id: 'test-id',
      content: 'test content',
    } as LLMToolMessage;
    return {
      message: defaultMessage,
      rawContent: 'test content',
      toolCallInfo: undefined,
      screen: undefined,
      info: undefined,
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
      admissionProvenance: { source: 'automatic' } as any,
      ...overrides,
    };
  }

  async function processResults(results: ToolCallResult[], sandbox: any = undefined): Promise<void> {
    const processor = new LargeToolResponseProcessor({
      dynamicSubAgentsPresent: false,
      individualTokenThreshold: 1000,
      totalTokenThreshold: 2000,
      previewNumberOfCharacters: 100,
      logger: makeSilentLogger(),
    });
    const execution = {
      sandbox,
    } as Readonly<AgentThreadExecutionContext>;
    await processor.process(results, execution);
  }

  describe('sandbox category', () => {
    it('replaces large sandbox output with bounded head', async () => {
      const sandbox = makeStubPublicSandbox();
      const largeOutput = Array.from({ length: 1000 }, (_, i) => `line ${String(i)}`).join('\n');
      const result = makeToolCallResult({
        message: { role: 'tool', tool_call_id: 'test-id', content: largeOutput } as LLMToolMessage,
        rawContent: largeOutput,
        info: { toolSet: sandbox, originalToolName: 'test-tool' } as any,
      });

      await processResults([result], sandbox);

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
      const result = makeToolCallResult({
        message: { role: 'tool', tool_call_id: 'test-id', content: largeOutput } as LLMToolMessage,
        rawContent: largeOutput,
        info: { toolSet: sandbox, originalToolName: 'test-tool' } as any,
      });

      await processResults([result], sandbox);

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
      const result = makeToolCallResult({
        message: { role: 'tool', tool_call_id: 'test-id', content: largeOutput } as LLMToolMessage,
        rawContent: largeOutput,
        info: { toolSet: sandbox, originalToolName: 'test-tool' } as any,
      });

      await processResults([result], sandbox);

      const content = result.message.content;
      expect(content).toContain(`of ${String(lineCount)} lines`);
      expect(content).toContain(`of ${String(largeOutput.length)} characters`);
    });
  });

  describe('mcp category', () => {
    it('large mcp output still uses 100-character preview', async () => {
      const largeOutput = 'x'.repeat(12_000);
      const differentSandbox = makeStubPublicSandbox();
      const result = makeToolCallResult({
        message: { role: 'tool', tool_call_id: 'test-id', content: largeOutput } as LLMToolMessage,
        rawContent: largeOutput,
        failure: false,
        info: { toolSet: differentSandbox, originalToolName: 'test-tool' } as any,
      });

      await processResults([result], makeStubPublicSandbox());

      const content = result.message.content;
      expect(content).toContain('Preview (first and last 100 chars)');
      expect(content).toContain('...');
      expect(result.outputTransform).toBe('replaced');
    });
  });
});

describe('bounded head function', () => {
  it('exports SANDBOX_LARGE_OUTPUT_HEAD_CHARS constant', () => {
    expect(SANDBOX_LARGE_OUTPUT_HEAD_CHARS).toBe(6_000);
  });
});
