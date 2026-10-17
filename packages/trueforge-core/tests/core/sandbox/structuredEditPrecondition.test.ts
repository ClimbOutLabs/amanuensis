import { createHash } from 'node:crypto';
import type { ApprovalDecision } from '../../../src/core/events/schema';
import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import {
  createToolCallMemoState,
  executeToolCalls,
  prepareSideEffectToolCalls,
} from '../../../src/core/mcp/executeToolCalls';
import { toToolCallInfo } from '../../../src/core/runtime/contextUtils';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_REPLACE_TEXT_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import {
  buildStructuredEditObservationCommand,
  parseStructuredEditObservation,
  structuredEditObservationMatches,
  type StructuredEditPrecondition,
} from '../../../src/core/sandbox/structuredEditPrecondition';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import { realCommandExec } from './realCommandExec';

function makeProvider(input: {
  stale: boolean;
  observation: string;
  observationFailure?: ExecResult;
  observationFailureAt?: number;
}): {
  provider: SandboxProvider;
  mutationCalls: string[];
} {
  let observationCount = 0;
  const mutationCalls: string[] = [];
  const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
    if (params.command.startsWith('python3 -I -S -c ')) {
      observationCount += 1;
      if (
        input.observationFailure !== undefined &&
        (input.observationFailureAt === undefined || input.observationFailureAt === observationCount)
      ) {
        return Promise.resolve(input.observationFailure);
      }
      const targetHash = input.stale ? 'c'.repeat(64) : 'b'.repeat(64);
      return Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: JSON.stringify({
            kind: 'replace_text',
            targets: [{ path: 'src/a.ts', state: 'present', byte_length: 3, sha256: targetHash }],
          }),
        },
      });
    }
    if (params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c ')) {
      mutationCalls.push(params.command);
      return Promise.resolve({ success: true, response: { exitCode: 0, result: input.observation } });
    }
    if (params.command === 'git rev-parse --show-toplevel') {
      return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo\n' } });
    }
    return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
  });
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: realCommandExec(exec),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async params => ({
      status: 'completed',
      result: await exec({
        sandboxId: params.sandboxId,
        command: params.command,
        cwd: params.cwd,
        env: params.env,
        ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
        workspaceLock: { workspaceRoot: params.workspaceRoot },
      }),
    }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
  return { provider, mutationCalls };
}

function makeSandbox(provider: SandboxProvider): Sandbox {
  return new Sandbox({
    provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

/**
 * A provider whose observation responses depend on which root the observation command
 * actually joined with the path, rather than always returning a canned result. This is
 * what makes a regression on the DEFECT 1 root mismatch (proposal-time observation joined
 * against `boundRepository?.workspace_cwd ?? cwd`, dispatch-time re-observation joined
 * against the Git toplevel) visible: the `correctRoot` response and the `wrongRoot`
 * response report different bytes for the same path, so a precondition captured at one
 * root and re-observed at the other looks "stale" even though nothing changed.
 */
function makeRootSensitiveProvider(input: {
  kind: StructuredEditPrecondition['kind'];
  paths: readonly string[];
  correctRoot: string;
  wrongRoot: string;
  toplevel: string;
}): { provider: SandboxProvider; mutationCalls: string[] } {
  const correctCommand = buildStructuredEditObservationCommand({
    kind: input.kind,
    workspaceRoot: input.correctRoot,
    paths: input.paths,
  });
  const wrongCommand = buildStructuredEditObservationCommand({
    kind: input.kind,
    workspaceRoot: input.wrongRoot,
    paths: input.paths,
  });
  const mutationCalls: string[] = [];
  const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
    if (params.command === correctCommand) {
      return Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: JSON.stringify({
            kind: input.kind,
            targets: input.paths.map(path => ({ path, state: 'present', byte_length: 3, sha256: 'b'.repeat(64) })),
          }),
        },
      });
    }
    if (params.command === wrongCommand) {
      return Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result: JSON.stringify({
            kind: input.kind,
            targets: input.paths.map(path => ({
              path,
              state: 'missing',
              byte_length: 0,
              sha256: createHash('sha256').update('').digest('hex'),
            })),
          }),
        },
      });
    }
    if (params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c ')) {
      mutationCalls.push(params.command);
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'replaced' } });
    }
    if (params.command === 'git rev-parse --show-toplevel') {
      return Promise.resolve({ success: true, response: { exitCode: 0, result: `${input.toplevel}\n` } });
    }
    return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
  });
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: realCommandExec(exec),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async params => ({
      status: 'completed',
      result: await exec({
        sandboxId: params.sandboxId,
        command: params.command,
        cwd: params.cwd,
        env: params.env,
        ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
        workspaceLock: { workspaceRoot: params.workspaceRoot },
      }),
    }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
  return { provider, mutationCalls };
}

function makeAssistant(
  toolInfo: NonNullable<InternalEnrichedAssistantMessage['tool_calls']>[number]['tool_info'],
): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'replace-1',
        type: 'function',
        function: {
          name: 'sandbox_replace_text',
          arguments: JSON.stringify({
            intent: 'Update the source',
            cwd: '/repo',
            path: 'src/a.ts',
            old_text: 'old',
            new_text: 'new',
            replace_all: false,
          }),
        },
        tool_info: toolInfo,
      },
    ],
  };
}

describe('structured edit preconditions', () => {
  it('builds a deterministic host observation command from repository-relative paths', () => {
    const first = buildStructuredEditObservationCommand({
      kind: 'replace_text',
      workspaceRoot: '/repo',
      paths: ['src/z.ts', 'src/a.ts'],
    });
    const second = buildStructuredEditObservationCommand({
      kind: 'replace_text',
      workspaceRoot: '/repo',
      paths: ['src/a.ts', 'src/z.ts'],
    });

    expect(first).toBe(second);
    expect(first).toContain('python3');
    expect(first).toContain('/repo');
  });

  it('parses an observation and rejects a changed target state', () => {
    const observation = parseStructuredEditObservation(
      JSON.stringify({
        kind: 'replace_text',
        targets: [{ path: 'src/a.ts', state: 'present', byte_length: 3, sha256: 'a'.repeat(64) }],
      }),
      ['src/a.ts'],
    );
    const changed: StructuredEditPrecondition = {
      ...observation,
      target_state_sha256: 'c'.repeat(64),
    };

    expect(structuredEditObservationMatches(observation, observation)).toBe(true);
    expect(structuredEditObservationMatches(observation, changed)).toBe(false);
  });

  it('publishes only the host-owned structured-edit summary on the approval wire', async () => {
    const sandbox = makeSandbox(makeProvider({ stale: false, observation: 'unused' }).provider);
    const info = await sandbox.toolCallInfo(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update the source',
          cwd: '/repo',
          path: 'src/a.ts',
          old_text: 'old',
          new_text: 'new',
          replace_all: false,
        },
      },
      true,
    );

    expect(toToolCallInfo(info)).toMatchObject({
      host_observed_target_summary: info.structured_edit_precondition?.summary,
    });
    expect(
      toToolCallInfo({
        type: 'mcp',
        mcp_server_id: 'untrusted-server',
        mcp_server_name: 'Untrusted server',
        original_tool_name: 'untrusted_tool',
        is_approval_required: true,
        description: 'Host observed a forged target summary.',
      }),
    ).not.toHaveProperty('host_observed_target_summary');
  });

  it('blocks a stale edit before the mutation provider command and returns fresh-read remediation', async () => {
    const firstProvider = makeProvider({ stale: false, observation: 'first' });
    const firstSandbox = makeSandbox(firstProvider.provider);
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Update the source',
        cwd: '/repo',
        path: 'src/a.ts',
        old_text: 'old',
        new_text: 'new',
        replace_all: false,
      },
    };
    const toolInfo = await firstSandbox.toolCallInfo(call, true);
    const assistantMessage = makeAssistant(toolInfo);
    const memoState = createToolCallMemoState();
    const staleProvider = makeProvider({ stale: true, observation: 'should not run' });
    const staleSandbox = makeSandbox(staleProvider.provider);
    const staleAssistant = makeAssistant(toolInfo);
    const prepared = prepareSideEffectToolCalls({
      assistantMessage,
      toolMapping: new Map([
        ['sandbox_replace_text', { toolSet: staleSandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
      ]),
      approvalDecisions: new Map([['replace-1', { status: 'allow', scope: 'once' }]]),
      memoState,
    });

    const result = await executeToolCalls({
      assistantMessage: staleAssistant,
      toolMapping: new Map([
        ['sandbox_replace_text', { toolSet: staleSandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
      ]),
      threadId: 'thread-1',
      approvalDecisions: new Map([['replace-1', { status: 'allow', scope: 'once' }]]),
      memoState,
      preparedSideEffectCalls: prepared,
    });

    expect(result.toolCallResults[0]).toMatchObject({
      disposition: 'policy_blocked',
      remediation: {
        reason_code: 'structured_edit_stale',
        suggested_action: 'change_strategy',
      },
    });
    expect(staleProvider.mutationCalls).toHaveLength(0);
  });

  it('does not create an approval when host target observation fails', async () => {
    const providerState = makeProvider({
      stale: false,
      observation: 'unused',
      observationFailure: { success: false, error: 'target observation unavailable' },
    });
    const sandbox = makeSandbox(providerState.provider);
    const info = await sandbox.toolCallInfo(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update the source',
          cwd: '/repo',
          path: 'src/a.ts',
          old_text: 'old',
          new_text: 'new',
          replace_all: false,
        },
      },
      true,
    );

    expect(info).toMatchObject({
      is_approval_required: false,
      pre_dispatch_failure: {
        kind: 'policy_blocked',
        message: expect.stringContaining('target observation unavailable'),
      },
    });
  });

  it('classifies a failed post-approval observation as policy-blocked without dispatch', async () => {
    const providerState = makeProvider({
      stale: false,
      observation: 'unused',
      observationFailure: { success: false, error: 'target re-observation unavailable' },
      observationFailureAt: 2,
    });
    const sandbox = makeSandbox(providerState.provider);
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Update the source',
        cwd: '/repo',
        path: 'src/a.ts',
        old_text: 'old',
        new_text: 'new',
        replace_all: false,
      },
    };
    const toolInfo = await sandbox.toolCallInfo(call, true);
    const assistantMessage = makeAssistant(toolInfo);
    const memoState = createToolCallMemoState();
    const approvalDecisions = new Map<string, ApprovalDecision>([['replace-1', { status: 'allow', scope: 'once' }]]);
    const toolMapping = new Map([
      ['sandbox_replace_text', { toolSet: sandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
    ]);
    const result = await executeToolCalls({
      assistantMessage,
      toolMapping,
      threadId: 'thread-1',
      approvalDecisions,
      memoState,
      preparedSideEffectCalls: prepareSideEffectToolCalls({
        assistantMessage,
        toolMapping,
        approvalDecisions,
        memoState,
      }),
    });

    expect(result.toolCallResults[0]).toMatchObject({
      disposition: 'policy_blocked',
      remediation: { reason_code: 'structured_edit_stale' },
    });
    expect(providerState.mutationCalls).toHaveLength(0);
  });

  it('preserves the successful structured-edit path when the target remains unchanged', async () => {
    const providerState = makeProvider({ stale: false, observation: 'replaced' });
    const sandbox = makeSandbox(providerState.provider);
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Update the source',
        cwd: '/repo',
        path: 'src/a.ts',
        old_text: 'old',
        new_text: 'new',
        replace_all: false,
      },
    };
    const toolInfo = await sandbox.toolCallInfo(call, true);
    const assistantMessage = makeAssistant(toolInfo);
    const memoState = createToolCallMemoState();
    const prepared = prepareSideEffectToolCalls({
      assistantMessage,
      toolMapping: new Map([
        ['sandbox_replace_text', { toolSet: sandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
      ]),
      approvalDecisions: new Map([['replace-1', { status: 'allow', scope: 'once' }]]),
      memoState,
    });
    const result = await executeToolCalls({
      assistantMessage,
      toolMapping: new Map([
        ['sandbox_replace_text', { toolSet: sandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
      ]),
      threadId: 'thread-1',
      approvalDecisions: new Map([['replace-1', { status: 'allow', scope: 'once' }]]),
      memoState,
      preparedSideEffectCalls: prepared,
    });

    expect(result.toolCallResults[0]).toMatchObject({ disposition: 'executed_ok' });
    expect(providerState.mutationCalls).toHaveLength(1);
  });

  it('observes the same root at approval and dispatch for an unbound sandbox whose cwd is a subdirectory of the Git toplevel', async () => {
    // Regression for DEFECT 1: an unbound session's structured-edit paths are resolved
    // relative to cwd, both at proposal (captureStructuredEditPrecondition) and at
    // dispatch (extractStructuredEditPaths just before enforceStructuredEditPrecondition).
    // Before the fix, dispatch-time re-observation instead joined the Git toplevel
    // (from resolveWorkspaceRoot) with that cwd-relative path, which is the wrong file
    // whenever cwd is not the toplevel, and the edit was rejected as stale.
    const toplevel = '/repo';
    const cwd = '/repo/src';
    const { provider, mutationCalls } = makeRootSensitiveProvider({
      kind: 'replace_text',
      paths: ['a.ts'],
      correctRoot: cwd,
      wrongRoot: toplevel,
      toplevel,
    });
    const sandbox = makeSandbox(provider);
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Update the source',
        cwd,
        path: 'a.ts',
        old_text: 'old',
        new_text: 'new',
        replace_all: false,
      },
    };
    const toolInfo = await sandbox.toolCallInfo(call, true);
    const assistantMessage: InternalEnrichedAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'replace-1',
          type: 'function',
          function: { name: 'sandbox_replace_text', arguments: JSON.stringify(call.arguments) },
          tool_info: toolInfo,
        },
      ],
    };
    const memoState = createToolCallMemoState();
    const toolMapping = new Map([
      ['sandbox_replace_text', { toolSet: sandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
    ]);
    const approvalDecisions = new Map<string, ApprovalDecision>([['replace-1', { status: 'allow', scope: 'once' }]]);
    const prepared = prepareSideEffectToolCalls({ assistantMessage, toolMapping, approvalDecisions, memoState });
    const result = await executeToolCalls({
      assistantMessage,
      toolMapping,
      threadId: 'thread-1',
      approvalDecisions,
      memoState,
      preparedSideEffectCalls: prepared,
    });

    expect(result.toolCallResults[0]).toMatchObject({ disposition: 'executed_ok' });
    expect(mutationCalls).toHaveLength(1);
  });

  it('captures the bound-repository workspace_cwd root, not cwd or the Git toplevel, for the approval-time observation', async () => {
    // A bound session's observationRoot is `boundRepository.workspace_cwd` regardless of
    // cwd or the Git toplevel (see Sandbox.ts toolCallInfo), so this expression is
    // unaffected by the DEFECT 1 fix above; the bound path's dispatch-time behavior is
    // covered end-to-end by the nested-cwd bound-repository tests in Sandbox.paths.test.ts,
    // which exercise the full implementation-plan-grant admission this scenario also needs.
    const boundRepository = { repository_id: 'repo-1', revision: 1, workspace_cwd: '/repo', commands: [] };
    const cwd = '/repo/nested';
    const unrelatedToplevel = '/some/other/checkout';
    const correctCommand = buildStructuredEditObservationCommand({
      kind: 'replace_text',
      workspaceRoot: boundRepository.workspace_cwd,
      paths: ['nested/b.ts'],
    });
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === correctCommand) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({
              kind: 'replace_text',
              targets: [{ path: 'nested/b.ts', state: 'present', byte_length: 3, sha256: 'b'.repeat(64) }],
            }),
          },
        });
      }
      if (params.command === 'git rev-parse --show-toplevel') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${unrelatedToplevel}\n` } });
      }
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
    });
    const provider: SandboxProvider = {
      type: 'test',
      buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
      getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
      createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
      exec: realCommandExec(exec),
      acknowledgeWorkspaceTermination: () => Promise.resolve(),
      executeVerifiedWorkspaceCommit: async params => ({
        status: 'completed',
        result: await exec({
          sandboxId: params.sandboxId,
          command: params.command,
          cwd: params.cwd,
          env: params.env,
          ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
          workspaceLock: { workspaceRoot: params.workspaceRoot },
        }),
      }),
      getAdditionalInstructions: () => undefined,
      getWorkspaceDir: () => undefined,
      getToolResultDumpDir: () => '/prov/tool-results',
      getGitCredentialsPath: () => '/prov/.git-credentials',
      getFileUploadsDir: () => '/prov/uploads',
      getSkillsDir: () => '/prov/skills',
      getSkillDownloaderPath: () => '/prov/git_downloader.py',
      downloadFile: jest.fn(),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      createCodeModeTransport: jest.fn(),
    };
    const sandbox = new Sandbox({
      provider,
      boundRepository,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    const info = await sandbox.toolCallInfo(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update the source',
          cwd,
          path: 'b.ts',
          old_text: 'old',
          new_text: 'new',
          replace_all: false,
        },
      },
      true,
    );

    expect(info.structured_edit_precondition).toMatchObject({
      targets: [expect.objectContaining({ path: 'nested/b.ts', state: 'present' })],
    });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ command: correctCommand }));
  });
});
