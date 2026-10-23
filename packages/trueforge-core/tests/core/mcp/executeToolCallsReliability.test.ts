import { McpConnectionError, ToolPolicyBlockedError, ToolPreDispatchError } from '../../../src/core/errors';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { approvalGrantKey } from '../../../src/core/mcp/approvalGrant';
import {
  createToolCallMemoState,
  executeToolCalls,
  prepareSideEffectToolCalls,
  shouldStopAfterMemoizedReplay,
  toToolCallMemoSnapshot,
} from '../../../src/core/mcp/executeToolCalls';
import { buildCanonicalToolCallResult } from '../../../src/core/runtime/AgentThread';

function assistantCall(input: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  effect?: InternalToolCallInfo['effect'];
  readOnlyHint?: boolean;
  commandExecution?: InternalToolCallInfo['command_execution'];
}): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: input.id,
        type: 'function',
        function: { name: input.name, arguments: JSON.stringify(input.arguments) },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'test',
          mcp_server_name: 'test',
          original_tool_name: input.name,
          is_approval_required: false,
          effect: input.effect,
          read_only_hint: input.readOnlyHint,
          command_execution: input.commandExecution,
        },
      },
    ],
  };
}

function toolSet(input: { name: string; resultText: string; isError?: boolean | undefined }): IToolSet {
  return {
    name: input.name,
    id: input.name,
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool: jest.fn(() => Promise.resolve(toolResultResponse({ text: input.resultText, isError: input.isError }))),
  };
}

describe('turn-scoped tool-call reliability', () => {
  it('distinguishes a host policy block from an uncertain remote failure', async () => {
    const blocked = toolSet({ name: 'blocked', resultText: 'must not run' });
    jest
      .mocked(blocked.callTool)
      .mockRejectedValue(new ToolPolicyBlockedError("Tool 'write_thing' is not allowed on MCP server blocked"));
    const remoteDenied = toolSet({ name: 'remote', resultText: 'must not run' });
    jest.mocked(remoteDenied.callTool).mockRejectedValue(new McpConnectionError('remote MCP returned 403', 403));

    const blockedResult = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'blocked-call', name: 'write_thing', arguments: {} }),
      toolMapping: new Map([['write_thing', { toolSet: blocked, originalToolName: 'write_thing' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });
    const remoteResult = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'remote-call', name: 'write_remote', arguments: {} }),
      toolMapping: new Map([['write_remote', { toolSet: remoteDenied, originalToolName: 'write_remote' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(blockedResult.toolCallResults[0]).toMatchObject({
      disposition: 'policy_blocked',
      remediation: { reason_code: 'tool_policy_blocked', suggested_action: 'change_strategy' },
    });
    expect(remoteResult.toolCallResults[0]).toMatchObject({
      disposition: 'outcome_unknown',
      remediation: { reason_code: 'execution_interrupted', suggested_action: 'inspect_state' },
    });
  });

  it('records a typed pre-dispatch setup failure as never run', async () => {
    const unavailable = toolSet({ name: 'unavailable', resultText: 'must not run' });
    jest
      .mocked(unavailable.callTool)
      .mockRejectedValue(new ToolPreDispatchError("Tool 'read_thing' could not be prepared for execution"));

    const result = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'setup-call', name: 'read_thing', arguments: {} }),
      toolMapping: new Map([['read_thing', { toolSet: unavailable, originalToolName: 'read_thing' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.toolCallResults[0]).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'tool_pre_dispatch_failed', suggested_action: 'retry' },
    });
  });

  it('emits an auth-required result with required remediation through the canonical v2 boundary', async () => {
    const authToolSet: IToolSet = {
      name: 'authenticated',
      id: 'authenticated',
      preload: true,
      hasPreloadedTools: true,
      listTools: jest.fn(),
      toolCallInfo: jest.fn(),
      callTool: jest.fn(() =>
        Promise.resolve({
          authRequired: {
            servers: [{ id: 'server-1', name: 'Authenticated server', auth_url: 'https://auth.example' }],
          },
        }),
      ),
    };
    const result = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'auth-call', name: 'read_private', arguments: {} }),
      toolMapping: new Map([['read_private', { toolSet: authToolSet, originalToolName: 'read_private' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.authRequirementInfo).toHaveLength(1);
    expect(result.toolCallResults).toHaveLength(1);
    expect(result.toolCallResults[0]).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'authentication_required', suggested_action: 'authenticate' },
    });
    const toolCallResult = result.toolCallResults[0];
    if (toolCallResult === undefined) {
      throw new Error('Expected the authentication result');
    }
    expect(() => buildCanonicalToolCallResult('main', toolCallResult)).not.toThrow();
  });

  it('runs a side-effecting call again after an earlier attempt was blocked by authRequired', async () => {
    const authToolSet: IToolSet = {
      name: 'connector',
      id: 'connector',
      preload: true,
      hasPreloadedTools: true,
      listTools: jest.fn(),
      toolCallInfo: jest.fn(),
      callTool: jest
        .fn()
        .mockResolvedValueOnce({
          authRequired: { servers: [{ id: 'server-1', name: 'Connector', auth_url: 'https://auth.example' }] },
        })
        .mockResolvedValueOnce(toolResultResponse({ text: 'sent' })),
    };
    const mapping = new Map([['send_message', { toolSet: authToolSet, originalToolName: 'send_message' }]]);
    const args = { to: 'someone@example.com', body: 'hello' };
    const firstMemo = createToolCallMemoState();

    const first = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'send-1', name: 'send_message', arguments: args, effect: 'edit' }),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: firstMemo,
    });
    expect(first.authRequirementInfo).toHaveLength(1);
    expect(first.toolCallResults[0]).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'authentication_required', suggested_action: 'authenticate' },
    });

    // The user authenticates and the model retries the identical call. The
    // host knew the first attempt never dispatched, so the durable marker
    // must not block the retry as an unknown-outcome repeat.
    const rebuiltMemo = createToolCallMemoState(toToolCallMemoSnapshot(firstMemo));
    const second = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'send-2', name: 'send_message', arguments: args, effect: 'edit' }),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: rebuiltMemo,
    });

    expect(authToolSet.callTool).toHaveBeenCalledTimes(2);
    expect(second.toolCallResults[0]).toMatchObject({
      failure: false,
      repeatedSideEffect: false,
      disposition: 'executed_ok',
    });
  });

  it('marks an MCP error result as a failed invocation', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'patch did not apply', isError: true });
    const result = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'patch-call', name: 'apply_patch', arguments: { patch: 'bad' } }),
      toolMapping: new Map([['apply_patch', { toolSet: sandbox, originalToolName: 'apply_patch' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.toolCallResults[0]).toMatchObject({ failure: true, disposition: 'executed_nonzero' });
  });

  it('unwraps error results into structured payloads instead of text blobs', async () => {
    const envelope = JSON.stringify({
      error: 'Report exceeds the compact mode limits (max 2 sections, 16 rows total, 4 notes).',
    });
    const documents = toolSet({ name: 'documents', resultText: envelope, isError: true });
    const result = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'report-call', name: 'create_document_report', arguments: {} }),
      toolMapping: new Map([
        ['create_document_report', { toolSet: documents, originalToolName: 'create_document_report' }],
      ]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    const toolResult = result.toolCallResults[0];
    expect(toolResult).toMatchObject({ failure: true, isStructuredContent: true });
    // The model receives the parsed error object, not the double-encoded
    // content-block array it used to get.
    expect(JSON.parse(toolResult?.message.content ?? '')).toEqual(JSON.parse(envelope));
  });

  it('degrades a non-JSON error result to a plain error object', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'patch did not apply', isError: true });
    const result = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'patch-call', name: 'apply_patch', arguments: { patch: 'bad' } }),
      toolMapping: new Map([['apply_patch', { toolSet: sandbox, originalToolName: 'apply_patch' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    const toolResult = result.toolCallResults[0];
    expect(toolResult).toMatchObject({ failure: true, isStructuredContent: true });
    expect(JSON.parse(toolResult?.message.content ?? '')).toEqual({ error: 'patch did not apply' });
  });

  it.each(['null', '[]', '42', '"text"'])('rejects non-object JSON tool arguments: %s', async rawArguments => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'must not run' });
    const toolMapping = new Map([['apply_patch', { toolSet: sandbox, originalToolName: 'apply_patch' }]]);
    const assistantMessage = assistantCall({
      id: 'invalid-arguments',
      name: 'apply_patch',
      arguments: {},
      effect: 'edit',
    });
    const toolCall = assistantMessage.tool_calls?.[0];
    if (toolCall === undefined) {
      throw new Error('expected one tool call');
    }
    toolCall.function.arguments = rawArguments;
    const memoState = createToolCallMemoState();

    expect(
      prepareSideEffectToolCalls({
        assistantMessage,
        toolMapping,
        approvalDecisions: new Map(),
        memoState,
      }).callIds,
    ).toEqual(new Set());

    const result = await executeToolCalls({
      assistantMessage,
      toolMapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
    });

    expect(sandbox.callTool).not.toHaveBeenCalled();
    expect(result.toolCallResults[0]).toMatchObject({
      failure: true,
      disposition: 'never_ran',
      remediation: { reason_code: 'invalid_tool_arguments', suggested_action: 'change_strategy' },
    });
    expect(result.toolCallResults[0]?.message.content).toContain('Tool arguments must be a JSON object');
  });

  it('serves an identical GitHub read from the turn memo', async () => {
    const github = toolSet({ name: 'github', resultText: 'file text' });
    const mapping = new Map([['get_file_contents', { toolSet: github, originalToolName: 'get_file_contents' }]]);
    const memoState = createToolCallMemoState();
    const common = { toolMapping: mapping, threadId: 'main', approvalDecisions: new Map(), memoState };

    await executeToolCalls({
      ...common,
      assistantMessage: assistantCall({ id: 'call-1', name: 'get_file_contents', arguments: { path: 'a.ts' } }),
    });
    const second = await executeToolCalls({
      ...common,
      assistantMessage: assistantCall({ id: 'call-2', name: 'get_file_contents', arguments: { path: 'a.ts' } }),
    });

    expect(github.callTool).toHaveBeenCalledTimes(1);
    expect(second.toolCallResults[0]).toMatchObject({ memoized: true, repeatCount: 2 });
  });

  it('coalesces simultaneous identical GitHub reads', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const github = toolSet({ name: 'github', resultText: 'file text' });
    jest.mocked(github.callTool).mockImplementation(async () => {
      await gate;
      return toolResultResponse({ text: 'file text' });
    });
    const mapping = new Map([['get_file_contents', { toolSet: github, originalToolName: 'get_file_contents' }]]);
    const memoState = createToolCallMemoState();
    const common = { toolMapping: mapping, threadId: 'main', approvalDecisions: new Map(), memoState };

    const first = executeToolCalls({
      ...common,
      assistantMessage: assistantCall({ id: 'call-1', name: 'get_file_contents', arguments: { path: 'a.ts' } }),
    });
    const second = executeToolCalls({
      ...common,
      assistantMessage: assistantCall({ id: 'call-2', name: 'get_file_contents', arguments: { path: 'a.ts' } }),
    });
    release?.();
    const [, secondResult] = await Promise.all([first, second]);

    expect(github.callTool).toHaveBeenCalledTimes(1);
    expect(secondResult.toolCallResults[0]).toMatchObject({ memoized: true, repeatCount: 2 });
  });

  it('continues to replay completed reads from a legacy memo snapshot', async () => {
    const github = toolSet({ name: 'github', resultText: 'file contents' });
    const mapping = new Map([['get_file_contents', { toolSet: github, originalToolName: 'get_file_contents' }]]);
    const firstMemo = createToolCallMemoState();
    const call = (id: string) =>
      assistantCall({ id, name: 'get_file_contents', arguments: { path: 'src/example.ts' } });

    await executeToolCalls({
      assistantMessage: call('legacy-read-1'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: firstMemo,
    });

    const currentSnapshot = toToolCallMemoSnapshot(firstMemo);
    const legacySnapshot = {
      ...currentSnapshot,
      read_results: currentSnapshot.read_results.map(
        ({ disposition: _disposition, remediation: _remediation, ...entry }) => entry,
      ),
    };
    const replayed = await executeToolCalls({
      assistantMessage: call('legacy-read-2'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(legacySnapshot),
    });

    expect(github.callTool).toHaveBeenCalledTimes(1);
    expect(replayed.toolCallResults[0]).toMatchObject({
      memoized: true,
      repeatCount: 2,
      disposition: 'executed_ok',
    });
  });

  it.each(['exec', 'apply_patch', 'structured_edit'])(
    'runs a repeated %s again after memo rebuild once the earlier outcome was observed as a success',
    async name => {
      const sandbox = toolSet({ name: 'sandbox', resultText: 'action accepted' });
      const mapping = new Map([[name, { toolSet: sandbox, originalToolName: name }]]);
      const firstMemo = createToolCallMemoState();
      const args = { command: 'update file', path: 'src/example.ts' };

      await executeToolCalls({
        assistantMessage: assistantCall({ id: `${name}-1`, name, arguments: args, effect: 'edit' }),
        toolMapping: mapping,
        threadId: 'main',
        approvalDecisions: new Map(),
        memoState: firstMemo,
      });

      // The prior attempt resolved to a definite, observed outcome (a
      // successful response), so the durable marker is already cleared by
      // the time the memo is snapshotted and rebuilt (e.g. across a turn
      // boundary). An identical retry is not "the terminal state is
      // unknown" — it is dispatched again like any other action.
      const rebuiltMemo = createToolCallMemoState(toToolCallMemoSnapshot(firstMemo));
      const second = await executeToolCalls({
        assistantMessage: assistantCall({
          id: `${name}-2`,
          name,
          arguments: { path: args.path, command: args.command },
          effect: 'edit',
        }),
        toolMapping: mapping,
        threadId: 'main',
        approvalDecisions: new Map(),
        memoState: rebuiltMemo,
      });

      expect(sandbox.callTool).toHaveBeenCalledTimes(2);
      expect(second.toolCallResults[0]).toMatchObject({
        failure: false,
        repeatedSideEffect: false,
        disposition: 'executed_ok',
      });
    },
  );

  it.each(['exec', 'apply_patch', 'structured_edit'])(
    'runs a repeated %s again after memo rebuild once the earlier outcome was an observed non-zero exit',
    async name => {
      const sandbox = toolSet({ name: 'sandbox', resultText: 'exit 128: fatal: not a git repository', isError: true });
      const mapping = new Map([[name, { toolSet: sandbox, originalToolName: name }]]);
      const firstMemo = createToolCallMemoState();
      const args = { command: 'write smoke.md', path: 'smoke.md' };

      const first = await executeToolCalls({
        assistantMessage: assistantCall({ id: `${name}-1`, name, arguments: args, effect: 'edit' }),
        toolMapping: mapping,
        threadId: 'main',
        approvalDecisions: new Map(),
        memoState: firstMemo,
      });
      expect(first.toolCallResults[0]).toMatchObject({ failure: true, disposition: 'executed_nonzero' });

      // A definite non-zero exit is just as observed as a success: the
      // action clearly did not take effect, so nothing about retrying it is
      // unknown.
      const rebuiltMemo = createToolCallMemoState(toToolCallMemoSnapshot(firstMemo));
      const second = await executeToolCalls({
        assistantMessage: assistantCall({
          id: `${name}-2`,
          name,
          arguments: { path: args.path, command: args.command },
          effect: 'edit',
        }),
        toolMapping: mapping,
        threadId: 'main',
        approvalDecisions: new Map(),
        memoState: rebuiltMemo,
      });

      expect(sandbox.callTool).toHaveBeenCalledTimes(2);
      expect(second.toolCallResults[0]).toMatchObject({
        failure: true,
        repeatedSideEffect: false,
        disposition: 'executed_nonzero',
      });
    },
  );

  it.each(['exec', 'apply_patch', 'structured_edit'])(
    'blocks a repeated %s when the earlier attempt threw before its outcome was ever observed',
    async name => {
      const sandbox = toolSet({ name: 'sandbox', resultText: 'unused' });
      jest.mocked(sandbox.callTool).mockRejectedValueOnce(new McpConnectionError('sandbox connection dropped', 503));
      const mapping = new Map([[name, { toolSet: sandbox, originalToolName: name }]]);
      const firstMemo = createToolCallMemoState();
      const args = { command: 'update file', path: 'src/example.ts' };

      const first = await executeToolCalls({
        assistantMessage: assistantCall({ id: `${name}-1`, name, arguments: args, effect: 'edit' }),
        toolMapping: mapping,
        threadId: 'main',
        approvalDecisions: new Map(),
        memoState: firstMemo,
      });
      expect(first.toolCallResults[0]).toMatchObject({ disposition: 'outcome_unknown' });

      const rebuiltMemo = createToolCallMemoState(toToolCallMemoSnapshot(firstMemo));
      const second = await executeToolCalls({
        assistantMessage: assistantCall({
          id: `${name}-2`,
          name,
          arguments: { path: args.path, command: args.command },
          effect: 'edit',
        }),
        toolMapping: mapping,
        threadId: 'main',
        approvalDecisions: new Map(),
        memoState: rebuiltMemo,
      });

      expect(sandbox.callTool).toHaveBeenCalledTimes(1);
      expect(second.toolCallResults[0]).toMatchObject({
        failure: true,
        repeatedSideEffect: true,
        repeatCount: 2,
        disposition: 'outcome_unknown',
        remediation: { reason_code: 'repeated_side_effect', suggested_action: 'inspect_state' },
      });
      expect(second.toolCallResults[0]?.message.content).toContain('do not retry');
    },
  );

  it('replays a completed verification against unchanged code and reruns it after a workspace mutation', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'format check failed', isError: true });
    const mapping = new Map([['exec', { toolSet: sandbox, originalToolName: 'exec' }]]);
    const firstMemo = createToolCallMemoState();
    const verification = (id: string) =>
      assistantCall({
        id,
        name: 'exec',
        arguments: { intent: `verification request ${id}`, purpose: 'verify', command: 'pnpm test', cwd: '/repo' },
        effect: 'verify',
        commandExecution: {
          repository_id: 'repo-1',
          repository_revision: 7,
          command_id: 'pnpm-test',
          command: 'pnpm test',
          cwd: '/repo',
          timeout_ms: 900_000,
        },
      });

    await executeToolCalls({
      assistantMessage: verification('verify-1'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: firstMemo,
    });

    const rebuiltMemo = createToolCallMemoState(toToolCallMemoSnapshot(firstMemo));
    const unchangedWorkspace = await executeToolCalls({
      assistantMessage: verification('verify-2'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: rebuiltMemo,
    });
    expect(unchangedWorkspace.toolCallResults[0]).toMatchObject({
      failure: true,
      memoized: true,
      repeatCount: 2,
      repeatedSideEffect: false,
      disposition: 'executed_nonzero',
    });
    const firstReplay = unchangedWorkspace.toolCallResults[0];
    if (firstReplay === undefined) throw new Error('Expected a verification replay');
    expect(shouldStopAfterMemoizedReplay(firstReplay)).toBe(false);

    const exhaustedReplay = await executeToolCalls({
      assistantMessage: verification('verify-2-again'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: rebuiltMemo,
    });
    const exhaustedResult = exhaustedReplay.toolCallResults[0];
    if (exhaustedResult === undefined) throw new Error('Expected an exhausted verification replay');
    expect(exhaustedResult).toMatchObject({ memoized: true, repeatCount: 3 });
    expect(shouldStopAfterMemoizedReplay(exhaustedResult)).toBe(true);

    rebuiltMemo.workspaceMutationEpoch += 1;
    const changedWorkspace = await executeToolCalls({
      assistantMessage: verification('verify-3'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: rebuiltMemo,
    });

    expect(sandbox.callTool).toHaveBeenCalledTimes(2);
    expect(changedWorkspace.toolCallResults[0]).toMatchObject({
      memoized: false,
      repeatedSideEffect: false,
      disposition: 'executed_nonzero',
    });
  });

  it('reruns verification after an executed command may have changed the workspace', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'unused' });
    jest
      .mocked(sandbox.callTool)
      .mockResolvedValueOnce(toolResultResponse({ text: 'format check failed', isError: true }))
      .mockResolvedValueOnce(toolResultResponse({ text: 'formatted App.tsx' }))
      .mockResolvedValueOnce(toolResultResponse({ text: 'verification passed' }));
    const mapping = new Map([['exec', { toolSet: sandbox, originalToolName: 'exec' }]]);
    const memoState = createToolCallMemoState();
    const verification = (id: string) =>
      assistantCall({
        id,
        name: 'exec',
        arguments: { intent: `verification request ${id}`, purpose: 'verify', command: 'pnpm verify', cwd: '/repo' },
        effect: 'verify',
        commandExecution: {
          repository_id: 'repo-1',
          repository_revision: 7,
          command_id: 'pnpm-verify',
          command: 'pnpm verify',
          cwd: '/repo',
          timeout_ms: 900_000,
        },
      });

    await executeToolCalls({
      assistantMessage: verification('verify-before-format'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
    });
    await executeToolCalls({
      assistantMessage: assistantCall({
        id: 'format',
        name: 'exec',
        arguments: { purpose: 'execute', command: 'pnpm prettier --write App.tsx', cwd: '/repo' },
        effect: 'execute',
      }),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
    });
    const afterFormat = await executeToolCalls({
      assistantMessage: verification('verify-after-format'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
    });

    expect(sandbox.callTool).toHaveBeenCalledTimes(3);
    expect(memoState.workspaceMutationEpoch).toBe(1);
    expect(afterFormat.toolCallResults[0]).toMatchObject({
      memoized: false,
      repeatedSideEffect: false,
      disposition: 'executed_ok',
    });
  });

  it('blocks a verification attempt carried by a legacy memo snapshot', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'tests completed' });
    const mapping = new Map([['exec', { toolSet: sandbox, originalToolName: 'exec' }]]);
    const verification = (id: string) =>
      assistantCall({
        id,
        name: 'exec',
        arguments: { purpose: 'verify', command: 'pnpm test', cwd: '/repo' },
        effect: 'verify',
      });
    const firstMemo = createToolCallMemoState();

    await executeToolCalls({
      assistantMessage: verification('legacy-verify-1'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: firstMemo,
    });

    const { workspace_mutation_epoch: _workspaceMutationEpoch, ...legacySnapshot } = toToolCallMemoSnapshot(firstMemo);
    legacySnapshot.read_results = [];
    legacySnapshot.side_effect_attempts = [
      {
        key: JSON.stringify(['sandbox', 'exec', { command: 'pnpm test', cwd: '/repo', purpose: 'verify' }]),
        count: 1,
      },
    ];
    const repeated = await executeToolCalls({
      assistantMessage: verification('legacy-verify-2'),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(legacySnapshot),
    });

    expect(sandbox.callTool).toHaveBeenCalledTimes(1);
    expect(repeated.toolCallResults[0]).toMatchObject({ failure: true, repeatedSideEffect: true });
  });

  it('does not let a read-only hint override an explicit side-effect classification', async () => {
    // A memoized read would just replay its cached result on an identical
    // call. Route the first attempt through an unobserved failure instead,
    // so a passing test proves the call was tracked as a side effect (and
    // its outcome-unknown retry blocked) rather than treated as a read.
    const sandbox = toolSet({ name: 'sandbox', resultText: 'unused' });
    jest.mocked(sandbox.callTool).mockRejectedValueOnce(new McpConnectionError('sandbox connection dropped', 503));
    const mapping = new Map([['apply_patch', { toolSet: sandbox, originalToolName: 'apply_patch' }]]);
    const memoState = createToolCallMemoState();
    const common = { toolMapping: mapping, threadId: 'main', approvalDecisions: new Map(), memoState };

    await executeToolCalls({
      ...common,
      assistantMessage: assistantCall({
        id: 'edit-1',
        name: 'apply_patch',
        arguments: { patch: 'change' },
        effect: 'edit',
        readOnlyHint: true,
      }),
    });
    const repeated = await executeToolCalls({
      ...common,
      assistantMessage: assistantCall({
        id: 'edit-2',
        name: 'apply_patch',
        arguments: { patch: 'change' },
        effect: 'edit',
        readOnlyHint: true,
      }),
    });

    expect(sandbox.callTool).toHaveBeenCalledTimes(1);
    expect(repeated.toolCallResults[0]).toMatchObject({
      failure: true,
      repeatedSideEffect: true,
      disposition: 'outcome_unknown',
    });
  });

  it('replays completed inspection results after memo snapshot hydration', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'file text' });
    const mapping = new Map([['exec', { toolSet: sandbox, originalToolName: 'exec' }]]);
    const firstMemo = createToolCallMemoState();

    await executeToolCalls({
      assistantMessage: assistantCall({
        id: 'inspect-1',
        name: 'exec',
        arguments: { command: 'Get-Content file.txt' },
        effect: 'inspect',
      }),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: firstMemo,
    });

    const rebuiltMemo = createToolCallMemoState(toToolCallMemoSnapshot(firstMemo));
    const second = await executeToolCalls({
      assistantMessage: assistantCall({
        id: 'inspect-2',
        name: 'exec',
        arguments: { command: 'Get-Content file.txt' },
        effect: 'inspect',
      }),
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: rebuiltMemo,
    });

    expect(sandbox.callTool).toHaveBeenCalledTimes(1);
    expect(second.toolCallResults[0]).toMatchObject({ memoized: true, repeatCount: 2 });
  });

  it('blocks a side effect recovered after its durable pre-dispatch marker', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'edited' });
    const mapping = new Map([['apply_patch', { toolSet: sandbox, originalToolName: 'apply_patch' }]]);
    const preparedCall = assistantCall({
      id: 'edit-prepared',
      name: 'apply_patch',
      arguments: { patch: 'change' },
      effect: 'edit',
    });
    const preparedMemo = createToolCallMemoState();
    const preparedCalls = prepareSideEffectToolCalls({
      assistantMessage: preparedCall,
      toolMapping: mapping,
      approvalDecisions: new Map(),
      memoState: preparedMemo,
    });

    expect(preparedCalls.callIds).toEqual(new Set(['edit-prepared']));

    const recoveredMemo = createToolCallMemoState(toToolCallMemoSnapshot(preparedMemo));
    const replayCall = assistantCall({
      id: 'edit-replayed',
      name: 'apply_patch',
      arguments: { patch: 'change' },
      effect: 'edit',
    });
    const replayPreparedCalls = prepareSideEffectToolCalls({
      assistantMessage: replayCall,
      toolMapping: mapping,
      approvalDecisions: new Map(),
      memoState: recoveredMemo,
    });
    const replay = await executeToolCalls({
      assistantMessage: replayCall,
      toolMapping: mapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: recoveredMemo,
      preparedSideEffectCalls: replayPreparedCalls,
    });

    expect(replayPreparedCalls.callIds.size).toBe(0);
    expect(sandbox.callTool).not.toHaveBeenCalled();
    expect(replay.toolCallResults[0]).toMatchObject({
      failure: true,
      repeatedSideEffect: true,
      repeatCount: 2,
    });
  });

  it('serializes a batch containing state-changing tool calls', async () => {
    let active = 0;
    let maximumActive = 0;
    const sandbox = toolSet({ name: 'sandbox', resultText: 'edited' });
    jest.mocked(sandbox.callTool).mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return toolResultResponse({ text: 'edited' });
    });
    const assistantMessage = assistantCall({ id: 'edit-1', name: 'replace_text', arguments: { replacement: 'a' } });
    const first = assistantMessage.tool_calls?.[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    first.tool_info.effect = 'edit';
    assistantMessage.tool_calls?.push({
      ...first,
      id: 'edit-2',
      function: { ...first.function, arguments: JSON.stringify({ replacement: 'b' }) },
    });

    const result = await executeToolCalls({
      assistantMessage,
      toolMapping: new Map([['replace_text', { toolSet: sandbox, originalToolName: 'replace_text' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(result.toolCallResults).toHaveLength(2);
    expect(maximumActive).toBe(1);
  });

  it('scopes a same-batch verification to the successful edit that precedes it', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'completed' });
    const assistantMessage = assistantCall({
      id: 'edit',
      name: 'apply_patch',
      arguments: { patch: 'change' },
      effect: 'edit',
    });
    const edit = assistantMessage.tool_calls?.[0];
    expect(edit).toBeDefined();
    if (edit === undefined) return;
    assistantMessage.tool_calls?.push({
      ...edit,
      id: 'verify',
      function: { name: 'exec', arguments: JSON.stringify({ command: 'pnpm verify' }) },
      tool_info: { ...edit.tool_info, original_tool_name: 'exec', effect: 'verify' },
    });
    const toolMapping = new Map([
      ['apply_patch', { toolSet: sandbox, originalToolName: 'apply_patch' }],
      ['exec', { toolSet: sandbox, originalToolName: 'exec' }],
    ]);
    const memoState = createToolCallMemoState();
    const preparedSideEffectCalls = prepareSideEffectToolCalls({
      assistantMessage,
      toolMapping,
      approvalDecisions: new Map(),
      memoState,
    });

    const result = await executeToolCalls({
      assistantMessage,
      toolMapping,
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
      preparedSideEffectCalls,
    });

    expect(sandbox.callTool).toHaveBeenCalledTimes(2);
    expect(result.toolCallResults).toHaveLength(2);
    expect(result.toolCallResults.every(item => !item.failure)).toBe(true);
    expect(memoState.workspaceMutationEpoch).toBe(1);
  });

  it('blocks a web fetch after a contentless authenticated GitHub read', async () => {
    const github = toolSet({
      name: 'github',
      resultText: JSON.stringify({ error: { code: 'github_file_content_unavailable' } }),
      isError: true,
    });
    const web = toolSet({ name: 'parallel-web', resultText: 'should not run' });
    const memoState = createToolCallMemoState();
    const common = { threadId: 'main', approvalDecisions: new Map(), memoState };
    await executeToolCalls({
      ...common,
      toolMapping: new Map([['get_file_contents', { toolSet: github, originalToolName: 'get_file_contents' }]]),
      assistantMessage: assistantCall({ id: 'call-1', name: 'get_file_contents', arguments: { path: 'private.ts' } }),
    });
    const fallback = await executeToolCalls({
      ...common,
      toolMapping: new Map([['web_fetch', { toolSet: web, originalToolName: 'web_fetch' }]]),
      assistantMessage: assistantCall({
        id: 'call-2',
        name: 'web_fetch',
        arguments: { url: 'https://raw.githubusercontent.com/acme/private/main/private.ts' },
      }),
    });

    expect(web.callTool).not.toHaveBeenCalled();
    expect(fallback.toolCallResults[0]).toMatchObject({
      failure: true,
      blockedPrivateFallback: true,
      disposition: 'policy_blocked',
      remediation: { reason_code: 'private_repository_fallback', suggested_action: 'change_strategy' },
    });
  });

  it('blocks a same-batch private API fallback before either call dispatches', async () => {
    const github = toolSet({ name: 'github', resultText: 'file text' });
    const web = toolSet({ name: 'parallel-web', resultText: 'should not run' });
    const assistantMessage = assistantCall({
      id: 'github-call',
      name: 'get_file_contents',
      arguments: { path: 'private.ts' },
    });
    assistantMessage.tool_calls?.push({
      id: 'web-call',
      type: 'function',
      function: {
        name: 'web_fetch',
        arguments: JSON.stringify({ url: 'https://api.github.com/repos/acme/private/contents/private.ts' }),
      },
      tool_info: {
        type: 'mcp',
        mcp_server_id: 'web',
        mcp_server_name: 'parallel-web',
        original_tool_name: 'web_fetch',
        is_approval_required: false,
      },
    });

    const result = await executeToolCalls({
      assistantMessage,
      toolMapping: new Map([
        ['get_file_contents', { toolSet: github, originalToolName: 'get_file_contents' }],
        ['web_fetch', { toolSet: web, originalToolName: 'web_fetch' }],
      ]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    expect(github.callTool).toHaveBeenCalledTimes(1);
    expect(web.callTool).not.toHaveBeenCalled();
    expect(result.toolCallResults.find(item => item.message.tool_call_id === 'web-call')).toMatchObject({
      blockedPrivateFallback: true,
    });
  });

  it('does not request or execute an exact action that was already denied in the turn', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'should not run' });
    const assistantMessage = assistantCall({
      id: 'repeated-call',
      name: 'exec',
      arguments: { command: 'git commit -m fix' },
    });
    const call = assistantMessage.tool_calls?.[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    call.tool_info.is_approval_required = true;
    call.tool_info.original_tool_name = 'exec:commit:abc123';
    const memoState = createToolCallMemoState();
    memoState.deniedApprovalIdentities.add(approvalGrantKey(call.tool_info));

    const result = await executeToolCalls({
      assistantMessage,
      toolMapping: new Map([['exec', { toolSet: sandbox, originalToolName: 'exec' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState,
    });

    expect(sandbox.callTool).not.toHaveBeenCalled();
    expect(memoState.repeatedDeniedApproval).toBe(true);
    expect(result.toolCallResults[0]).toMatchObject({
      failure: true,
      disposition: 'denied',
      remediation: { reason_code: 'repeated_denied_action', suggested_action: 'contact_user' },
    });
    expect(result.toolCallResults[0]?.message.content).toContain('Do not try it again');
  });

  it('records a current user denial separately from a policy block', async () => {
    const sandbox = toolSet({ name: 'sandbox', resultText: 'must not run' });
    const result = await executeToolCalls({
      assistantMessage: assistantCall({ id: 'denied-call', name: 'exec', arguments: { command: 'do thing' } }),
      toolMapping: new Map([['exec', { toolSet: sandbox, originalToolName: 'exec' }]]),
      threadId: 'main',
      approvalDecisions: new Map([['denied-call', { status: 'deny', reason: 'not now' }]]),
      memoState: createToolCallMemoState(),
    });

    expect(sandbox.callTool).not.toHaveBeenCalled();
    expect(result.toolCallResults[0]).toMatchObject({
      failure: true,
      disposition: 'denied',
      admissionProvenance: { source: 'user_approval', decision: 'deny' },
    });
  });
});
