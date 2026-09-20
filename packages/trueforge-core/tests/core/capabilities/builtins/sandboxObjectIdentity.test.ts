import { largeToolResponse } from '../../../../src/core/capabilities/builtins/LargeToolResponse';
import type { IToolSet } from '../../../../src/core/mcp/IMCPServer';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger, makeStubPublicSandbox } from '../../harnessMocks';

const silentLogger = makeSilentLogger();

const LARGE_CONTENT = 'x'.repeat(50_000);

function makeToolResult(
  toolSet: IToolSet,
  name: string,
  overrides: Partial<Pick<ToolCallResult, 'failure' | 'remediation'>> = {},
): ToolCallResult {
  return {
    message: {
      role: 'tool',
      tool_call_id: 'call-1',
      content: LARGE_CONTENT,
    },
    rawContent: LARGE_CONTENT,
    toolCallInfo: undefined,
    screen: undefined,
    info: {
      toolSet,
      originalToolName: name,
    },
    failure: false,
    isStructuredContent: false,
    completedAt: new Date().toISOString(),
    memoized: false,
    repeatCount: 1,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'executed_ok',
    remediation: undefined,
    admissionProvenance: { source: 'automatic' },
    ...overrides,
  };
}

describe('LargeToolResponse sandbox object identity (ISSUE-035)', () => {
  it('classifies only the exact Sandbox instance as sandbox category', async () => {
    const sandbox = makeStubPublicSandbox();
    const sandboxNamedMcp = makeMockIMCPServer({ name: 'sandbox', preload: true });

    const processor = largeToolResponse({
      dynamicSubAgentsPresent: false,
      settings: { individualTokenThreshold: 100, totalTokenThreshold: 200 },
      logger: silentLogger,
      tracing: NOOP_AGENT_TRACING,
    }).toolResponseProcessors?.[0];
    expect(processor).toBeDefined();
    if (!processor) throw new Error('expected largeToolResponse processor');

    const sandboxResult = makeToolResult(sandbox, 'exec');
    const mcpResult = makeToolResult(sandboxNamedMcp, 'search');

    await processor.process([sandboxResult, mcpResult], {
      threadId: 'main',
      signal: undefined,
      sandbox,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    });

    expect(sandboxResult.message.content).toContain('write to a file');
    expect(sandboxResult.message.content).toContain('the rest was not seen');
    expect(sandboxResult.message.content).toContain(
      'it must tell the user the result was too large to use and answer only from what it actually has',
    );
    expect(mcpResult.message.content).not.toContain('write to a file');
    expect(mcpResult.message.content).toContain('Content too big');
    expect(mcpResult.message.content).toContain('The Agent has not seen this tool result.');
    // The change is recorded in a host-owned field beside the remediation, so a report can name
    // it without trusting the text.
    expect(sandboxResult.outputTransform).toBe('replaced');
    expect(mcpResult.outputTransform).toBe('replaced');
    expect(sandboxResult.remediation).toBeUndefined();
  });
});

describe('LargeToolResponse output transform', () => {
  it('cuts a long failure message and keeps its own remediation beside the truncation', async () => {
    const sandbox = makeStubPublicSandbox();
    const processor = largeToolResponse({
      dynamicSubAgentsPresent: false,
      settings: { individualTokenThreshold: 100, totalTokenThreshold: 200 },
      logger: silentLogger,
      tracing: NOOP_AGENT_TRACING,
    }).toolResponseProcessors?.[0];
    if (!processor) throw new Error('expected largeToolResponse processor');
    const remediation = {
      reason_code: 'subagent_failed',
      message: 'The child failed.',
      suggested_action: 'retry' as const,
    };
    const failed = makeToolResult(sandbox, 'exec', { failure: true, remediation });

    await processor.process([failed], {
      threadId: 'main',
      signal: undefined,
      sandbox,
      currentContextUsage: getEmptyCurrentContextUsage(),
      context: [],
    });

    expect(failed.message.content.length).toBeLessThan(LARGE_CONTENT.length);
    expect(failed.outputTransform).toBe('truncated');
    expect(failed.remediation).toEqual(remediation);
  });
});
