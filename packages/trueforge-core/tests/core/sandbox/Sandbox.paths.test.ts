import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApprovalDecision, ToolAdmissionProvenance } from '../../../src/core/events/schema';
import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type InternalEnrichedAssistantMessage,
  type InternalEnrichedToolCall,
  type RawAssistantMessageWithUsage,
} from '../../../src/core/llm/LLMTypes';
import { effectiveToolAdmissions } from '../../../src/core/mcp/approvalGrant';
import {
  createToolCallMemoState,
  executeToolCalls,
  prepareSideEffectToolCalls,
} from '../../../src/core/mcp/executeToolCalls';
import { isCallToolResponseResult, type ToolInvocationContext } from '../../../src/core/mcp/IMCPServer';
import {
  implementationPlanCheckoutId,
  mintImplementationPlanGrant,
  serializeImplementationPlanGrant,
} from '../../../src/core/mcp/implementationPlanGrant';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { CodeModeTransport } from '../../../src/core/sandbox/codeMode/CodeModeTransport';
import type { SandboxInvocationPurpose } from '../../../src/core/sandbox/commandClassification';
import {
  withTrustedPath,
  type ExecResult,
  type SandboxExecParams,
  type SandboxProvider,
} from '../../../src/core/sandbox/provider/Provider';
import {
  APPLY_PATCH_CHECK_FAILURE_HINT,
  buildWriteAndRunScriptCommand,
  Sandbox,
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_MCP_SERVER_ID,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
  sandboxCommandApprovalIdentity,
  sandboxCommandEffect,
  SandboxFileUploadError,
  type BoundRepository,
  type RepositoryCommandSourceObserver,
  type WorkspaceVerificationCoordinator,
} from '../../../src/core/sandbox/Sandbox';
import { SANDBOX_START_FAILED_MESSAGE, SandboxNotAvailableError } from '../../../src/core/sandbox/SandboxErrors';
import {
  REQUESTED_SKILLS_FILE_NAME,
  SkillMounter,
  type GitSkill,
  type Skill,
} from '../../../src/core/sandbox/skills/SkillMounter';
import { structuredEditObservationForTargets } from '../../../src/core/sandbox/structuredEditPrecondition';
import { GIT_INDEX_ENTRIES_COMMAND, TRACKED_WORKTREE_COMMAND } from '../../../src/core/sandbox/workspaceStateCapture';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { withTimeout } from '../../../src/core/util/promiseUtils';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';
import { TestDurableWorkspaceCoordinator } from './durableWorkspaceCoordinator';
import { fakeTrackedState } from './fakeTrackedState';
import { realCommandExec } from './realCommandExec';

function readyExec(): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
}

async function activateVerificationCandidate(sandbox: Sandbox, response: Awaited<ReturnType<Sandbox['callTool']>>) {
  if (!isCallToolResponseResult(response) || response.verificationReceiptCandidate === undefined) {
    throw new Error('Expected a verification receipt candidate');
  }
  await expect(
    sandbox.activateVerificationReceipt(response.verificationReceiptCandidate, {
      event_id: 'durable-verification-event',
      thread_id: 'main',
      tool_call_id: 'durable-verification-call',
    }),
  ).resolves.toBe(true);
}

const GIT_TRACKED_PATH_TAGS_COMMAND = 'git ls-files -v -z';
const DEFAULT_CHECKOUT_NODES = '101 .git\n101 /repo/.git';
const DEFAULT_CHECKOUT_ID = implementationPlanCheckoutId({
  provider_type: 'test',
  sandbox_id: 'raw-1',
  repository_root: '/repo',
  git_dir: '/repo/.git',
  checkout_nodes: DEFAULT_CHECKOUT_NODES,
});
const BOUND_REPOSITORY_STATE_COMMAND =
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD';

const APP_INDEX_SHA = '1'.repeat(40);
const APP_WORKTREE_SHA = '2'.repeat(40);
const APP_CHANGED_LISTING =
  fakeTrackedState([{ path: 'src/app.ts', indexSha: APP_INDEX_SHA, worktreeSha: '3'.repeat(40) }])[
    TRACKED_WORKTREE_COMMAND
  ] ?? '';

const EMPTY_TRACKED_STATE = fakeTrackedState([]);

const BASE_GIT_STATE_RESULTS: Readonly<Record<string, string>> = {
  'git rev-parse --show-toplevel': '/repo',
  'git rev-parse --abbrev-ref HEAD': 'feature/reliable-agent',
  'git rev-parse HEAD': '0123456789abcdef',
  [GIT_TRACKED_PATH_TAGS_COMMAND]: 'H src/app.ts\0',
  ...fakeTrackedState([{ path: 'src/app.ts', indexSha: APP_INDEX_SHA, worktreeSha: APP_WORKTREE_SHA }]),
  'git ls-files --others --exclude-standard -z': '',
};

function makeVerificationExec(input: {
  verificationCommand: string;
  verificationResult: ExecResult;
  afterState: Readonly<Record<string, string | undefined>>;
}): jest.MockedFunction<(params: SandboxExecParams) => Promise<ExecResult>> {
  let verificationRan = false;
  return jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
    if (params.command === input.verificationCommand) {
      verificationRan = true;
      return Promise.resolve(input.verificationResult);
    }
    const state = verificationRan ? { ...BASE_GIT_STATE_RESULTS, ...input.afterState } : BASE_GIT_STATE_RESULTS;
    if (Object.prototype.hasOwnProperty.call(state, params.command) && state[params.command] === undefined) {
      return Promise.resolve({ success: false, error: 'state unavailable' });
    }
    return Promise.resolve({
      success: true,
      response: { exitCode: 0, result: state[params.command] ?? 'ok' },
    });
  });
}

function makeProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  const { exec: overrideExec, ...providerOverrides } = overrides;
  const exec = async (params: SandboxExecParams): Promise<ExecResult> => {
    const result = overrideExec === undefined ? await readyExec() : await overrideExec(params);
    const emptyTrackedState = EMPTY_TRACKED_STATE[params.command];
    if (emptyTrackedState !== undefined && result.success && result.response.result === 'ok') {
      return { success: true, response: { ...result.response, result: emptyTrackedState } };
    }
    if (
      params.command === BOUND_REPOSITORY_STATE_COMMAND &&
      result.success &&
      result.response.exitCode === 0 &&
      result.response.result === 'ok'
    ) {
      const readLegacyField = async (command: string): Promise<ExecResult> => {
        const legacy = overrideExec === undefined ? await readyExec() : await overrideExec({ ...params, command });
        const fallback = BASE_GIT_STATE_RESULTS[command];
        if (
          fallback !== undefined &&
          legacy.success &&
          legacy.response.exitCode === 0 &&
          legacy.response.result === 'ok'
        ) {
          return { success: true, response: { ...legacy.response, result: fallback } };
        }
        return legacy;
      };
      const [root, branch, head] = await Promise.all([
        readLegacyField('git rev-parse --show-toplevel'),
        readLegacyField('git rev-parse --abbrev-ref HEAD'),
        readLegacyField('git rev-parse HEAD'),
      ]);
      if (!root.success || !branch.success || !head.success) {
        return { success: false, error: 'atomic repository state unavailable' };
      }
      return {
        success: true,
        response: {
          ...result.response,
          result: `${root.response.result.trim()}\n${branch.response.result.trim()}\n${head.response.result.trim()}\n`,
        },
      };
    }
    if (params.command.startsWith('python3 -I -S -c ') && result.success && result.response.result === 'ok') {
      const path = params.command.includes('src/runtime.ts')
        ? 'src/runtime.ts'
        : params.command.includes('src/app.ts')
          ? 'src/app.ts'
          : params.command.includes('a.txt')
            ? 'a.txt'
            : 'src/runtime.ts';
      return {
        success: true,
        response: {
          ...result.response,
          result: JSON.stringify({
            kind: params.command.includes('apply_patch') ? 'apply_patch' : 'replace_text',
            targets: [{ path, state: 'present', byte_length: 3, sha256: 'b'.repeat(64) }],
          }),
        },
      };
    }
    const canonicalResult =
      params.command === 'git rev-parse --show-toplevel'
        ? '/repo'
        : params.command === 'git rev-parse --absolute-git-dir'
          ? '/repo/.git'
          : params.command.startsWith('ls -di -- .git ')
            ? DEFAULT_CHECKOUT_NODES
            : undefined;
    if (canonicalResult !== undefined && result.success && result.response.result === 'ok') {
      return { success: true, response: { ...result.response, result: canonicalResult } };
    }
    return result;
  };
  return {
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
    getSkillDownloaderPath: () => '/prov/skill_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
    ...providerOverrides,
  };
}

async function structuredEditContext(
  sandbox: Sandbox,
  call: Parameters<Sandbox['callTool']>[0],
  context: ToolInvocationContext,
): Promise<ToolInvocationContext> {
  const toolInfo = await sandbox.toolCallInfo(call, true);
  if (toolInfo.structured_edit_precondition === undefined) {
    throw new Error('Expected host-observed structured-edit precondition');
  }
  return { ...context, structured_edit_precondition: toolInfo.structured_edit_precondition };
}

function makeSandbox(
  provider: SandboxProvider,
  options: {
    existingSandboxId?: string;
    boundRepository?: BoundRepository;
    loadBoundRepository?: () => Promise<BoundRepository | undefined>;
    workspaceVerificationCoordinator?: WorkspaceVerificationCoordinator;
    onRepositorySources?: RepositoryCommandSourceObserver;
    ocrLanguages?: string;
    skillMounter?: SkillMounter;
  } = {},
): Sandbox {
  return new Sandbox({
    provider,
    existingSandboxId: options.existingSandboxId,
    boundRepository: options.boundRepository,
    loadBoundRepository:
      options.loadBoundRepository ??
      (options.boundRepository === undefined ? undefined : () => Promise.resolve(options.boundRepository)),
    onRepositorySources: options.onRepositorySources,
    workspaceVerificationCoordinator:
      options.workspaceVerificationCoordinator ??
      (options.boundRepository === undefined ? undefined : new TestDurableWorkspaceCoordinator()),
    workspaceLeaseOwnerId: options.boundRepository === undefined ? undefined : 'test-replica',
    skillMounter: options.skillMounter,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    ocrLanguages: options.ocrLanguages,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

describe('Sandbox provider-owned paths', () => {
  const boundRepository: BoundRepository = {
    repository_id: 'repo-1',
    revision: 4,
    workspace_cwd: '/repo',
    commands: [
      {
        command_id: 'verify',
        purpose: 'verify',
        command: 'pnpm verify',
        timeout_ms: 900_000,
      },
    ],
  };
  const makeRepositorySandbox = (
    provider: SandboxProvider,
    coordinator: WorkspaceVerificationCoordinator = new TestDurableWorkspaceCoordinator(),
    options: { existingSandboxId?: string } = {},
  ): Sandbox =>
    makeSandbox(provider, {
      boundRepository,
      workspaceVerificationCoordinator: coordinator,
      ...(options.existingSandboxId === undefined ? {} : { existingSandboxId: options.existingSandboxId }),
    });

  const planOwner = {
    tenant_id: 'tenant-a',
    created_by: 'user-a',
    session_id: 'session-a',
    workspace_cwd: '/repo',
    checkout_id: DEFAULT_CHECKOUT_ID,
    turn_id: 'running-turn',
    beginDispatch: (): Promise<{ status: 'admitted' }> => Promise.resolve({ status: 'admitted' }),
    completeDispatch: (): Promise<void> => Promise.resolve(),
  };

  function planGrant() {
    return mintImplementationPlanGrant({
      ...planOwner,
      plan: {
        repository_id: boundRepository.repository_id,
        repository_revision: boundRepository.revision,
        branch: 'codex/task',
        head_sha: '0123456789abcdef',
        file_globs: ['src/**/*.ts'],
        approach: 'Update the scoped runtime behavior.',
        verify_command_ids: ['verify'],
      },
    });
  }

  function planInvocationContext(
    grant: ReturnType<typeof planGrant>,
    dispatchId = 'sandbox-plan-test-dispatch',
    kind: 'replace_text' | 'apply_patch' = 'replace_text',
  ): ToolInvocationContext {
    return {
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
      dispatch_id: dispatchId,
      structured_edit_precondition: structuredEditObservationForTargets({
        kind,
        targets: [{ path: 'src/runtime.ts', state: 'present', byte_length: 3, sha256: 'b'.repeat(64) }],
      }),
    };
  }

  function makePlanStateProvider(): SandboxProvider {
    return makeProvider({
      exec: (params: SandboxExecParams): Promise<ExecResult> => {
        const result =
          params.command === 'git rev-parse --abbrev-ref HEAD'
            ? planGrant().plan.branch
            : params.command === 'git rev-parse HEAD'
              ? planGrant().plan.head_sha
              : 'ok';
        return Promise.resolve({ success: true, response: { exitCode: 0, result } });
      },
    });
  }

  it('injects refreshed bound-repository state and registered command IDs', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const output = params.command === BOUND_REPOSITORY_STATE_COMMAND ? '/repo\ncodex/task\n0123456789abcdef\n' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result: output } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });

    await sandbox.refreshBoundRepositoryState();
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();

    expect(prompt).toContain('repository_id: repo-1');
    expect(prompt).toContain('workspace_cwd: /repo');
    expect(prompt).toContain('branch: codex/task');
    expect(prompt).toContain('head_sha: 0123456789abcdef');
    expect(prompt).toContain('command_id: verify');
    expect(prompt).toContain('Use run_registered_command');
    const stateReads = exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND);
    expect(stateReads).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: 'raw-1',
        command: BOUND_REPOSITORY_STATE_COMMAND,
        cwd: '/repo',
        workspaceLock: { workspaceRoot: '/repo' },
      }),
    );
  });

  it('rejects an atomic Git observation from a different repository root', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      void params;
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: '/other-checkout\ncodex/wrong\ndeadbeef\n' },
      });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });

    await expect(sandbox.refreshBoundRepositoryState()).rejects.toThrow('does not match bound checkout');
    expect(sandbox.getBoundRepositoryContext()).toMatchObject({ branch: null, head_sha: null });
    expect(exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND)).toHaveLength(1);
  });

  it('does not advertise implementation-plan submission in an unbound session', async () => {
    const sandbox = makeSandbox(makeProvider());
    const listed = await sandbox.listTools();

    expect(listed.result.tools.some(tool => tool.name === SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME)).toBe(false);
  });

  it('returns current repository identity when an implementation plan is stale', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(planGrant()),
    });
    await sandbox.refreshBoundRepositoryState();

    const response = await sandbox.callTool(
      {
        name: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
        arguments: { ...planGrant().plan, repository_revision: boundRepository.revision - 1 },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    if (!isCallToolResponseResult(response) || response.result.content[0]?.type !== 'text') {
      throw new Error('Expected a text implementation-plan failure');
    }
    expect(JSON.parse(response.result.content[0].text)).toEqual(
      expect.objectContaining({
        reason_code: 'stale_plan',
        mismatches: ['repository_revision'],
        current: {
          repository_id: 'repo-1',
          repository_revision: 4,
          branch: 'codex/task',
          head_sha: '0123456789abcdef',
          available_verify_command_ids: ['verify'],
        },
      }),
    );
  });

  it('durably activates an Allow in this chat plan before reporting it active', async () => {
    const grant = planGrant();
    const persistGrant = jest.fn(() => Promise.resolve());
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --abbrev-ref HEAD'
          ? grant.plan.branch
          : params.command === 'git rev-parse HEAD'
            ? grant.plan.head_sha
            : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant,
      loadGrant: () => Promise.resolve(grant),
    });
    await sandbox.refreshBoundRepositoryState();

    const response = await sandbox.callTool(
      { name: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME, arguments: grant.plan },
      { status: 'allow', scope: 'chat' },
    );

    expect(persistGrant).toHaveBeenCalledWith(grant);
    expect(isCallToolResponseResult(response)).toBe(true);
    if (isCallToolResponseResult(response)) {
      expect(response.result.isError).not.toBe(true);
      expect(response.result.content).toContainEqual({
        type: 'text',
        text: JSON.stringify({
          grant_id: grant.grant_id,
          status: 'active',
          message: 'The implementation plan grant is active for this chat until revoked or repository state drifts.',
        }),
      });
    }
  });

  it('does not activate a plan when the checkout drifts while approval is pending', async () => {
    const grant = planGrant();
    const persistGrant = jest.fn(() => Promise.resolve());
    let liveBranch = grant.plan.branch;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --abbrev-ref HEAD'
          ? liveBranch
          : params.command === 'git rev-parse HEAD'
            ? grant.plan.head_sha
            : params.command === 'git rev-parse --show-toplevel'
              ? boundRepository.workspace_cwd
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant,
      loadGrant: () => Promise.resolve(grant),
    });
    await sandbox.refreshBoundRepositoryState();
    liveBranch = 'other/branch';

    const response = await sandbox.callTool(
      { name: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME, arguments: grant.plan },
      { status: 'allow', scope: 'chat' },
    );

    expect(persistGrant).not.toHaveBeenCalled();
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('drift');
  });

  it('does not activate a plan when the durable repository revision drifts while approval is pending', async () => {
    const grant = planGrant();
    const persistGrant = jest.fn(() => Promise.resolve());
    let liveBinding = boundRepository;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --abbrev-ref HEAD'
          ? grant.plan.branch
          : params.command === 'git rev-parse HEAD'
            ? grant.plan.head_sha
            : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), {
      boundRepository,
      loadBoundRepository: () => Promise.resolve(liveBinding),
    });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant,
      loadGrant: () => Promise.resolve(grant),
    });
    await sandbox.refreshBoundRepositoryState();
    liveBinding = { ...boundRepository, revision: boundRepository.revision + 1 };

    const response = await sandbox.callTool(
      { name: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME, arguments: grant.plan },
      { status: 'allow', scope: 'chat' },
    );

    expect(persistGrant).not.toHaveBeenCalled();
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('revision');
  });

  it('normalizes a nested-cwd replace_text scope relative to the bound repository root', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    await sandbox.refreshBoundRepositoryState();
    const argumentsValue = {
      intent: 'Update the package implementation',
      cwd: '/repo/packages/a',
      path: 'src/x.ts',
      old_text: 'before',
      new_text: 'after',
    };
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: argumentsValue,
    });
    const call: InternalEnrichedToolCall = {
      id: 'nested-remapped-replace',
      type: 'function',
      function: {
        name: 'sandbox_replace_text_2',
        arguments: JSON.stringify(argumentsValue),
      },
      tool_info: info,
    };
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      plan: {
        ...planGrant().plan,
        file_globs: ['packages/a/src/**/*.ts'],
      },
    });

    expect(info).toMatchObject({
      implementation_plan_scope: { kind: 'paths', paths: ['packages/a/src/x.ts'] },
    });
    expect(
      effectiveToolAdmissions({
        calls: [call],
        decisions: new Map(),
        chatApprovalGrants: new Set(),
        implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
      }).get(call.id),
    ).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('normalizes an absolute replace_text path inside cwd to the same scope a relative path would get', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    await sandbox.refreshBoundRepositoryState();
    const argumentsValue = {
      intent: 'Update the package implementation',
      cwd: '/repo/packages/a',
      path: '/repo/packages/a/src/x.ts',
      old_text: 'before',
      new_text: 'after',
    };
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: argumentsValue,
    });

    expect(info).toMatchObject({
      implementation_plan_scope: { kind: 'paths', paths: ['packages/a/src/x.ts'] },
    });
  });

  it('rejects an absolute replace_text path outside the bound repository root', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    await sandbox.refreshBoundRepositoryState();
    const info = await sandbox.toolCallInfo({
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Escape the repository',
        cwd: '/repo',
        path: '/etc/passwd',
        old_text: 'before',
        new_text: 'after',
      },
    });

    expect(info.implementation_plan_scope).toBeUndefined();
  });

  it('uses the bound repository root to authorize a repository-relative edit when cwd is omitted', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    await sandbox.refreshBoundRepositoryState();
    const argumentsValue = {
      path: 'packages/a/src/x.ts',
      old_text: 'before',
      new_text: 'after',
    };
    const call: InternalEnrichedToolCall = {
      id: 'bound-root-replace-without-cwd',
      type: 'function',
      function: {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: JSON.stringify(argumentsValue),
      },
      tool_info: await sandbox.toolCallInfo({
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: argumentsValue,
      }),
    };
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      plan: {
        ...planGrant().plan,
        file_globs: ['packages/a/src/**/*.ts'],
      },
    });

    expect(call.tool_info.implementation_plan_scope).toEqual({
      kind: 'paths',
      paths: ['packages/a/src/x.ts'],
    });
    expect(
      effectiveToolAdmissions({
        calls: [call],
        decisions: new Map(),
        chatApprovalGrants: new Set(),
        implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
      }).get(call.id),
    ).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('does not let a root-level glob authorize a same-looking path beneath a nested cwd', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    await sandbox.refreshBoundRepositoryState();
    const argumentsValue = {
      intent: 'Update the package implementation',
      cwd: '/repo/packages/a',
      path: 'src/x.ts',
      old_text: 'before',
      new_text: 'after',
    };
    const call: InternalEnrichedToolCall = {
      id: 'nested-root-lookalike',
      type: 'function',
      function: {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: JSON.stringify(argumentsValue),
      },
      tool_info: await sandbox.toolCallInfo({
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: argumentsValue,
      }),
    };
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      plan: {
        ...planGrant().plan,
        file_globs: ['src/**/*.ts'],
      },
    });

    expect(
      effectiveToolAdmissions({
        calls: [call],
        decisions: new Map(),
        chatApprovalGrants: new Set(),
        implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
      }).get(call.id),
    ).toEqual({
      decision: undefined,
      admission_provenance: { source: 'automatic' },
    });
  });

  it('normalizes nested-cwd patch headers relative to the bound repository root', async () => {
    const sandbox = makeSandbox(makePlanStateProvider(), { boundRepository });
    await sandbox.refreshBoundRepositoryState();
    const argumentsValue = {
      intent: 'Update the package implementation',
      cwd: '/repo/packages/a',
      patch: 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-before\n+after\n',
    };
    const call: InternalEnrichedToolCall = {
      id: 'nested-patch',
      type: 'function',
      function: {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: JSON.stringify(argumentsValue),
      },
      tool_info: await sandbox.toolCallInfo({
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: argumentsValue,
      }),
    };
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      plan: {
        ...planGrant().plan,
        file_globs: ['packages/a/src/**/*.ts'],
      },
    });

    expect(call.tool_info.implementation_plan_scope).toEqual({
      kind: 'paths',
      paths: ['packages/a/src/x.ts'],
    });
    expect(
      effectiveToolAdmissions({
        calls: [call],
        decisions: new Map(),
        chatApprovalGrants: new Set(),
        implementationPlanGrants: new Set([serializeImplementationPlanGrant(grant)]),
      }).get(call.id),
    ).toEqual({
      decision: { status: 'allow', scope: 'once' },
      admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
    });
  });

  it('blocks a planned nested-cwd edit when the effective cwd resolves to another Git root', async () => {
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      plan: { ...planGrant().plan, file_globs: ['packages/a/src/**/*.ts'] },
    });
    let requestedDispatches = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 ')) requestedDispatches += 1;
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo/packages/a'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update the nested package',
          cwd: '/repo/packages/a',
          path: 'src/x.ts',
          old_text: 'before',
          new_text: 'after',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'nested-git-root'),
    );

    const response = await pending;
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('does not resolve to the bound repository workspace');
    expect(requestedDispatches).toBe(0);
  });

  it('rejects an allowed Git header followed by an unlisted traditional patch section before mutation dispatch', async () => {
    const grant = planGrant();
    let requestedDispatches = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes('git apply --recount --unidiff-zero -- ') && !params.command.includes('--check')) {
        requestedDispatches += 1;
      }
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? boundRepository.workspace_cwd
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
    });
    const patch =
      'diff --git a/src/runtime.ts b/src/runtime.ts\n' +
      '--- a/src/runtime.ts\n' +
      '+++ b/src/runtime.ts\n' +
      '@@ -1 +1 @@\n' +
      '-old\n' +
      '+new\n' +
      '--- a/docs/private.md\n' +
      '+++ b/docs/private.md\n' +
      '@@ -1 +1 @@\n' +
      '-private\n' +
      '+exposed\n';

    const response = await sandbox.callTool(
      {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: { intent: 'Update runtime behavior', cwd: boundRepository.workspace_cwd, patch },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'adversarial-patch', 'apply_patch'),
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('unambiguous Git-format unified diff');
    expect(requestedDispatches).toBe(0);
  });

  it('refreshes branch and HEAD under the workspace mutation boundary immediately before a planned edit', async () => {
    const commandOrder: string[] = [];
    const grant = planGrant();
    const loadGrant = jest.fn(() => {
      commandOrder.push('load-durable-grant');
      return Promise.resolve(grant);
    });
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      commandOrder.push(params.command);
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant,
      beginDispatch: () => {
        commandOrder.push('durable-dispatch-boundary');
        return Promise.resolve({ status: 'admitted' });
      },
    });
    const patch =
      'diff --git a/src/runtime.ts b/src/runtime.ts\n--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@ -1 +1 @@\n-old\n+new\n';

    const response = await sandbox.callTool(
      {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: { intent: 'Update runtime behavior', cwd: '/repo', patch },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'final-refresh-order', 'apply_patch'),
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    const applyIndex = commandOrder.findIndex(command => command.includes('git apply --recount --unidiff-zero -- '));
    const durableIndex = commandOrder.lastIndexOf('load-durable-grant');
    const checkoutIndex = commandOrder.map(command => command.startsWith('ls -di ')).lastIndexOf(true);
    const branchIndex = commandOrder.findIndex(
      (command, index) =>
        index > durableIndex && index < checkoutIndex && command === 'git rev-parse --abbrev-ref HEAD',
    );
    const headIndex = commandOrder.findIndex(
      (command, index) => index > durableIndex && index < checkoutIndex && command === 'git rev-parse HEAD',
    );
    const boundaryIndex = commandOrder.lastIndexOf('durable-dispatch-boundary');
    expect(branchIndex).toBeGreaterThan(-1);
    expect(headIndex).toBeGreaterThan(-1);
    expect(branchIndex).toBeGreaterThan(durableIndex);
    expect(headIndex).toBeGreaterThan(durableIndex);
    expect(checkoutIndex).toBeGreaterThan(headIndex);
    expect(boundaryIndex).toBe(checkoutIndex + 1);
    expect(applyIndex).toBe(boundaryIndex + 1);
  });

  it('reports a thrown final repository refresh as never run and permits one safe retry', async () => {
    const grant = planGrant();
    let branchRefreshes = 0;
    let requestedDispatches = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'git rev-parse --abbrev-ref HEAD') {
        branchRefreshes += 1;
        // The durable mutation guard captures the full verification identity
        // first; fail the subsequent implementation-plan refresh itself.
        if (branchRefreshes === 2) {
          return Promise.reject(new Error('Git helper transport unavailable'));
        }
        return Promise.resolve({ success: true, response: { exitCode: 0, result: grant.plan.branch } });
      }
      if (params.command === 'git rev-parse HEAD') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: grant.plan.head_sha } });
      }
      if (params.command.includes('git apply --recount --unidiff-zero -- ') && !params.command.includes('--check')) {
        requestedDispatches += 1;
      }
      const result = params.command === 'git rev-parse --show-toplevel' ? '/repo' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
    });
    const patch =
      'diff --git a/src/runtime.ts b/src/runtime.ts\n--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const toolMapping = new Map([
      [SANDBOX_APPLY_PATCH_TOOL_NAME, { toolSet: sandbox, originalToolName: SANDBOX_APPLY_PATCH_TOOL_NAME }],
    ]);
    const memoState = createToolCallMemoState();
    const approvalFor = (callId: string): Map<string, ApprovalDecision> =>
      new Map([[callId, { status: 'allow', scope: 'once' }]]);
    const provenanceFor = (callId: string): Map<string, ToolAdmissionProvenance> =>
      new Map([[callId, { source: 'implementation_plan_grant', grant_id: grant.grant_id }]]);
    const assistantMessageFor = (callId: string): InternalEnrichedAssistantMessage => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: SANDBOX_APPLY_PATCH_TOOL_NAME,
            arguments: JSON.stringify({ intent: 'Update runtime behavior', cwd: '/repo', patch }),
          },
          tool_info: {
            type: 'mcp',
            mcp_server_id: SANDBOX_MCP_SERVER_ID,
            mcp_server_name: 'sandbox',
            original_tool_name: `${SANDBOX_APPLY_PATCH_TOOL_NAME}:edit`,
            is_approval_required: true,
            effect: 'edit',
            structured_edit_precondition: structuredEditObservationForTargets({
              kind: 'apply_patch',
              targets: [{ path: 'src/runtime.ts', state: 'present', byte_length: 3, sha256: 'b'.repeat(64) }],
            }),
          },
        },
      ],
    });

    const firstMessage = assistantMessageFor('planned-refresh');
    const firstDecisions = approvalFor('planned-refresh');
    const firstPrepared = prepareSideEffectToolCalls({
      assistantMessage: firstMessage,
      toolMapping,
      approvalDecisions: firstDecisions,
      memoState,
    });
    const first = await executeToolCalls({
      assistantMessage: firstMessage,
      toolMapping,
      threadId: 'main',
      approvalDecisions: firstDecisions,
      admissionProvenance: provenanceFor('planned-refresh'),
      memoState,
      preparedSideEffectCalls: firstPrepared,
    });

    expect(requestedDispatches).toBe(0);
    expect(first.toolCallResults).toHaveLength(1);
    expect(first.toolCallResults[0]).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'tool_pre_dispatch_failed', suggested_action: 'retry' },
    });
    expect(memoState.sideEffectAttempts.size).toBe(0);

    const retryMessage = assistantMessageFor('planned-refresh-retry');
    const retryDecisions = approvalFor('planned-refresh-retry');
    const retryPrepared = prepareSideEffectToolCalls({
      assistantMessage: retryMessage,
      toolMapping,
      approvalDecisions: retryDecisions,
      memoState,
    });
    const retry = await executeToolCalls({
      assistantMessage: retryMessage,
      toolMapping,
      threadId: 'main',
      approvalDecisions: retryDecisions,
      admissionProvenance: provenanceFor('planned-refresh-retry'),
      memoState,
      preparedSideEffectCalls: retryPrepared,
    });

    expect(retryPrepared.callIds).toEqual(new Set(['planned-refresh-retry']));
    expect(requestedDispatches).toBe(1);
    expect(retry.toolCallResults).toHaveLength(1);
    expect(retry.toolCallResults[0]).toMatchObject({ disposition: 'executed_ok', failure: false });
  });

  it('blocks a planned edit before dispatch when the actual branch drifted after approval', async () => {
    const grant = planGrant();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? 'main'
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: '/repo',
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'branch-drift'),
    );

    await expect(pending).rejects.toThrow('branch drifted');
    expect(exec.mock.calls.some(call => call[0].command.startsWith('python3 '))).toBe(false);
  });

  it('blocks a planned registered command before dispatch when the actual HEAD drifted after approval', async () => {
    const grant = planGrant();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? 'fedcba9876543210'
              : (BASE_GIT_STATE_RESULTS[params.command] ?? 'ok');
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
        arguments: { intent: 'Verify the repository', command_id: 'verify' },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'head-drift'),
    );

    await expect(pending).rejects.toThrow('HEAD drifted');
    expect(exec.mock.calls.some(call => call[0].command === 'pnpm verify')).toBe(false);
  });

  it('blocks a planned edit before dispatch when the durable repository revision drifted', async () => {
    const grant = planGrant();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), {
      boundRepository,
      loadBoundRepository: () => Promise.resolve({ ...boundRepository, revision: boundRepository.revision + 1 }),
    });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: '/repo',
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'revision-drift'),
    );

    await expect(pending).rejects.toThrow('repository revision');
    expect(exec.mock.calls.some(call => call[0].command.startsWith('python3 '))).toBe(false);
  });

  it('blocks a replaced checkout with the same repository revision, branch, and HEAD', async () => {
    const originalCheckoutId = implementationPlanCheckoutId({
      provider_type: 'test',
      sandbox_id: 'raw-1',
      repository_root: '/repo',
      git_dir: '/repo/.git',
      checkout_nodes: '101 .git\n101 /repo/.git',
    });
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      checkout_id: originalCheckoutId,
      plan: planGrant().plan,
    });
    let requestedDispatches = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 ')) requestedDispatches += 1;
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --absolute-git-dir'
            ? '/repo/.git'
            : params.command.startsWith('ls -di ')
              ? '202 .git\n202 /repo/.git'
              : params.command === 'git rev-parse --abbrev-ref HEAD'
                ? grant.plan.branch
                : params.command === 'git rev-parse HEAD'
                  ? grant.plan.head_sha
                  : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      turn_id: 'running-turn',
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
      beginDispatch: () => Promise.resolve({ status: 'admitted' }),
      completeDispatch: () => Promise.resolve(),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: '/repo',
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      {
        admission_provenance: { source: 'implementation_plan_grant', grant_id: grant.grant_id },
        dispatch_id: 'replaced-checkout-dispatch',
      },
    );

    await expect(pending).rejects.toThrow('checkout');
    expect(requestedDispatches).toBe(0);
  });

  it('blocks a rebind from checkout A to B with the same repository revision, branch, and HEAD', async () => {
    const checkoutA: BoundRepository = { ...boundRepository, workspace_cwd: '/repo-a' };
    const checkoutB: BoundRepository = { ...boundRepository, workspace_cwd: '/repo-b' };
    const grant = mintImplementationPlanGrant({
      ...planOwner,
      workspace_cwd: checkoutA.workspace_cwd,
      checkout_id: implementationPlanCheckoutId({
        provider_type: 'test',
        sandbox_id: 'raw-1',
        repository_root: checkoutA.workspace_cwd,
        git_dir: `${checkoutA.workspace_cwd}/.git`,
        checkout_nodes: '101 .git\n101 /repo-a/.git',
      }),
      plan: planGrant().plan,
    });
    let requestedDispatches = 0;
    const beginDispatch = jest.fn((): Promise<{ status: 'admitted' }> => Promise.resolve({ status: 'admitted' }));
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 ')) requestedDispatches += 1;
      const commandCwd = params.cwd ?? '';
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? commandCwd
          : params.command === 'git rev-parse --absolute-git-dir'
            ? `${commandCwd}/.git`
            : params.command.startsWith('ls -di ')
              ? `202 .git\n202 ${commandCwd}/.git`
              : params.command === 'git rev-parse --abbrev-ref HEAD'
                ? grant.plan.branch
                : params.command === 'git rev-parse HEAD'
                  ? grant.plan.head_sha
                  : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), {
      boundRepository: checkoutA,
      loadBoundRepository: () => Promise.resolve(checkoutB),
    });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      turn_id: 'running-turn',
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
      beginDispatch,
      completeDispatch: () => Promise.resolve(),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: checkoutA.workspace_cwd,
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'rebound-checkout-dispatch'),
    );

    await expect(pending).rejects.toThrow('checkout changed');
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git rev-parse --show-toplevel', cwd: checkoutB.workspace_cwd }),
    );
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(requestedDispatches).toBe(0);
  });

  it('blocks a planned edit when the session is unbound before final dispatch admission', async () => {
    const grant = planGrant();
    let requestedDispatches = 0;
    const beginDispatch = jest.fn((): Promise<{ status: 'admitted' }> => Promise.resolve({ status: 'admitted' }));
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 ')) requestedDispatches += 1;
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), {
      boundRepository,
      loadBoundRepository: () => Promise.resolve(undefined),
    });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      turn_id: 'running-turn',
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(grant),
      beginDispatch,
      completeDispatch: () => Promise.resolve(),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: '/repo',
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'unbound-dispatch'),
    );

    await expect(pending).rejects.toThrow('Could not refresh the repository checkout');
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(requestedDispatches).toBe(0);
  });

  it('re-reads durable grant state and blocks a revoked plan before dispatch', async () => {
    const grant = planGrant();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: () => Promise.resolve(undefined),
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: '/repo',
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'revoked-grant'),
    );

    await expect(pending).rejects.toThrow('revoked');
    expect(exec.mock.calls.some(call => call[0].command.startsWith('python3 '))).toBe(false);
  });

  it('blocks dispatch when revocation commits before the final durable admission read completes', async () => {
    const grant = planGrant();
    let requestedDispatches = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c ')) {
        requestedDispatches += 1;
      }
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    let signalLoadStarted: (() => void) | undefined;
    const loadStarted = new Promise<void>(resolve => {
      signalLoadStarted = resolve;
    });
    let releaseLoad: (() => void) | undefined;
    const loadReleased = new Promise<void>(resolve => {
      releaseLoad = resolve;
    });
    let revoked = false;
    const loadGrant = jest.fn(async () => {
      signalLoadStarted?.();
      await loadReleased;
      return revoked ? undefined : grant;
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant,
    });

    const pending = sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Update runtime behavior',
          cwd: '/repo',
          path: 'src/runtime.ts',
          old_text: 'old',
          new_text: 'new',
        },
      },
      { status: 'allow', scope: 'once' },
      planInvocationContext(grant, 'revoke-during-read'),
    );

    await loadStarted;
    revoked = true;
    releaseLoad?.();
    expect(loadGrant).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow('revoked');
    expect(requestedDispatches).toBe(0);
  });

  it('records final plan revocation as policy_blocked and permits the same call with a replacement plan', async () => {
    const grant = planGrant();
    const replacementGrant = mintImplementationPlanGrant({
      ...planOwner,
      plan: {
        ...grant.plan,
        file_globs: ['src/runtime.ts'],
        approach: 'Replace the revoked plan with the exact runtime edit.',
      },
    });
    let requestedDispatches = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c ')) {
        requestedDispatches += 1;
      }
      const result =
        params.command === 'git rev-parse --show-toplevel'
          ? '/repo'
          : params.command === 'git rev-parse --abbrev-ref HEAD'
            ? grant.plan.branch
            : params.command === 'git rev-parse HEAD'
              ? grant.plan.head_sha
              : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    let signalLoadStarted: (() => void) | undefined;
    const loadStarted = new Promise<void>(resolve => {
      signalLoadStarted = resolve;
    });
    let releaseLoad: (() => void) | undefined;
    const loadReleased = new Promise<void>(resolve => {
      releaseLoad = resolve;
    });
    let activeGrant = grant;
    let firstLoad = true;
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });
    sandbox.setImplementationPlanGrantContext({
      ...planOwner,
      persistGrant: () => Promise.resolve(),
      loadGrant: async grantId => {
        if (firstLoad) {
          firstLoad = false;
          signalLoadStarted?.();
          await loadReleased;
        }
        return activeGrant.grant_id === grantId ? activeGrant : undefined;
      },
    });
    const toolMapping = new Map([
      [SANDBOX_REPLACE_TEXT_TOOL_NAME, { toolSet: sandbox, originalToolName: SANDBOX_REPLACE_TEXT_TOOL_NAME }],
    ]);
    const memoState = createToolCallMemoState();
    const assistantMessageFor = (callId: string): InternalEnrichedAssistantMessage => ({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
            arguments: JSON.stringify({
              intent: 'Update runtime behavior',
              cwd: '/repo',
              path: 'src/runtime.ts',
              old_text: 'old',
              new_text: 'new',
            }),
          },
          tool_info: {
            type: 'mcp',
            mcp_server_id: SANDBOX_MCP_SERVER_ID,
            mcp_server_name: 'sandbox',
            original_tool_name: `${SANDBOX_REPLACE_TEXT_TOOL_NAME}:edit`,
            is_approval_required: true,
            effect: 'edit',
            structured_edit_precondition: structuredEditObservationForTargets({
              kind: 'replace_text',
              targets: [{ path: 'src/runtime.ts', state: 'present', byte_length: 3, sha256: 'b'.repeat(64) }],
            }),
          },
        },
      ],
    });
    const decisionsFor = (callId: string): Map<string, ApprovalDecision> =>
      new Map([[callId, { status: 'allow', scope: 'once' }]]);

    const blockedMessage = assistantMessageFor('revoked-plan-edit');
    const blockedDecisions = decisionsFor('revoked-plan-edit');
    const blockedPrepared = prepareSideEffectToolCalls({
      assistantMessage: blockedMessage,
      toolMapping,
      approvalDecisions: blockedDecisions,
      memoState,
    });
    const pending = executeToolCalls({
      assistantMessage: blockedMessage,
      toolMapping,
      threadId: 'main',
      approvalDecisions: blockedDecisions,
      admissionProvenance: new Map([
        ['revoked-plan-edit', { source: 'implementation_plan_grant', grant_id: grant.grant_id }],
      ]),
      memoState,
      preparedSideEffectCalls: blockedPrepared,
    });

    await loadStarted;
    activeGrant = replacementGrant;
    releaseLoad?.();
    const blocked = await pending;

    expect(requestedDispatches).toBe(0);
    expect(blocked.toolCallResults).toHaveLength(1);
    expect(blocked.toolCallResults[0]).toMatchObject({
      disposition: 'policy_blocked',
      remediation: {
        reason_code: 'implementation_plan_admission_blocked',
        suggested_action: 'request_approval',
      },
    });
    expect(memoState.sideEffectAttempts.size).toBe(0);

    const retryMessage = assistantMessageFor('revoked-plan-edit');
    const retryDecisions = decisionsFor('revoked-plan-edit');
    const retryPrepared = prepareSideEffectToolCalls({
      assistantMessage: retryMessage,
      toolMapping,
      approvalDecisions: retryDecisions,
      memoState,
    });
    const retry = await executeToolCalls({
      assistantMessage: retryMessage,
      toolMapping,
      threadId: 'main',
      approvalDecisions: retryDecisions,
      admissionProvenance: new Map([
        ['revoked-plan-edit', { source: 'implementation_plan_grant', grant_id: replacementGrant.grant_id }],
      ]),
      memoState,
      preparedSideEffectCalls: retryPrepared,
    });

    expect(retryPrepared.callIds).toEqual(new Set(['revoked-plan-edit']));
    expect(requestedDispatches).toBe(1);
    expect(retry.toolCallResults).toHaveLength(1);
    expect(retry.toolCallResults[0]).toMatchObject({ disposition: 'executed_ok', failure: false });
  });

  it('observes bounded repository command sources without exposing their contents in the prompt', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result = params.command === BOUND_REPOSITORY_STATE_COMMAND ? '/repo\nmain\nabcdef\n' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const downloadFile = jest.fn(({ path }: { sandboxId: string; path: string }): Promise<Buffer> => {
      if (path.endsWith('AGENTS.md')) {
        return Promise.resolve(Buffer.from('- Verify: `pnpm verify`'));
      }
      if (path.endsWith('package.json')) {
        return Promise.resolve(Buffer.from('{"scripts":{"test":"jest"}}'));
      }
      return Promise.reject(new Error('missing'));
    });
    const onRepositorySources = jest.fn(() => Promise.resolve());
    const sandbox = makeSandbox(makeProvider({ exec, downloadFile }), {
      boundRepository,
      onRepositorySources,
    });

    await sandbox.refreshBoundRepositoryState();
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();

    expect(onRepositorySources).toHaveBeenCalledTimes(1);
    expect(onRepositorySources).toHaveBeenCalledWith({
      sources: [
        expect.objectContaining({
          source_kind: 'agents_md',
          source_path: 'AGENTS.md',
          content: '- Verify: `pnpm verify`',
          source_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          source_kind: 'package_json',
          source_path: 'package.json',
          content: '{"scripts":{"test":"jest"}}',
          source_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      ],
      signal: undefined,
    });
    expect(prompt).not.toContain('pnpm verify');
    expect(prompt).not.toContain('jest');
  });

  it('cancels a blocked sandbox creation at the provider boundary', async () => {
    const createSandbox = jest.fn(
      (_options?: { signal?: AbortSignal | undefined }): Promise<{ sandboxId: string }> => new Promise(() => undefined),
    );
    const sandbox = makeSandbox(makeProvider({ createSandbox }), { boundRepository });
    const controller = new AbortController();

    const refresh = sandbox.refreshBoundRepositoryState({ signal: controller.signal });
    await Promise.resolve();
    expect(createSandbox).toHaveBeenCalledWith({ signal: controller.signal });

    controller.abort(new Error('stop blocked sandbox creation'));
    await expect(withTimeout(refresh, 500, 'blocked sandbox creation cancellation')).rejects.toThrow(
      'stop blocked sandbox creation',
    );
  });

  it('cancels a blocked provider Git observation with the turn signal', async () => {
    const stateReadStarted = Promise.withResolvers<void>();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === BOUND_REPOSITORY_STATE_COMMAND) {
        stateReadStarted.resolve();
        return new Promise(() => undefined);
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ exec }), {
      existingSandboxId: 'v1:test:raw-1',
      boundRepository,
    });
    const controller = new AbortController();

    const refresh = sandbox.refreshBoundRepositoryState({ signal: controller.signal });
    await withTimeout(stateReadStarted.promise, 500, 'provider Git observation start');
    const stateCall = exec.mock.calls.find(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND);
    expect(stateCall?.[0].signal).toBe(controller.signal);

    controller.abort(new Error('stop blocked Git observation'));
    await expect(withTimeout(refresh, 500, 'blocked Git observation cancellation')).rejects.toThrow(
      'stop blocked Git observation',
    );
  });

  it('cancels a blocked repository source download with the turn signal', async () => {
    const sourceReadStarted = Promise.withResolvers<void>();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result = params.command === BOUND_REPOSITORY_STATE_COMMAND ? '/repo\nmain\nabcdef\n' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const downloadFile = jest.fn(
      (params: { sandboxId: string; path: string; signal?: AbortSignal | undefined }): Promise<Buffer> => {
        void params;
        sourceReadStarted.resolve();
        return new Promise(() => undefined);
      },
    );
    const onRepositorySources = jest.fn(() => Promise.resolve());
    const sandbox = makeSandbox(makeProvider({ exec, downloadFile }), {
      existingSandboxId: 'v1:test:raw-1',
      boundRepository,
      onRepositorySources,
    });
    const controller = new AbortController();

    const refresh = sandbox.refreshBoundRepositoryState({ signal: controller.signal });
    await withTimeout(sourceReadStarted.promise, 500, 'repository source download start');
    expect(downloadFile.mock.calls[0]?.[0].signal).toBe(controller.signal);

    controller.abort(new Error('stop blocked source download'));
    await expect(withTimeout(refresh, 500, 'blocked source download cancellation')).rejects.toThrow(
      'stop blocked source download',
    );
    expect(onRepositorySources).not.toHaveBeenCalled();
    expect(sandbox.getBoundRepositoryContext()).toMatchObject({ branch: null, head_sha: null });
  });

  it('passes cancellation into repository source synchronization before state publication', async () => {
    const observerStarted = Promise.withResolvers<AbortSignal>();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result = params.command === BOUND_REPOSITORY_STATE_COMMAND ? '/repo\nmain\nabcdef\n' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const downloadFile = jest.fn(({ path }: { sandboxId: string; path: string }): Promise<Buffer> => {
      if (path.endsWith('AGENTS.md')) {
        return Promise.resolve(Buffer.from('repository instructions'));
      }
      return Promise.reject(new Error('missing'));
    });
    const observeRepositorySources: RepositoryCommandSourceObserver = async input => {
      void input.sources;
      const signal = input.signal;
      if (signal === undefined) {
        throw new Error('repository source observer did not receive cancellation');
      }
      observerStarted.resolve(signal);
      if (!signal.aborted) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
    };
    const onRepositorySources = jest.fn(observeRepositorySources);
    const sandbox = makeSandbox(makeProvider({ exec, downloadFile }), {
      existingSandboxId: 'v1:test:raw-1',
      boundRepository,
      onRepositorySources,
    });
    const controller = new AbortController();

    const refresh = sandbox.refreshBoundRepositoryState({ signal: controller.signal });
    expect(await withTimeout(observerStarted.promise, 500, 'repository source observer')).toBe(controller.signal);
    controller.abort(new Error('cancel repository source synchronization'));

    await expect(withTimeout(refresh, 500, 'repository source synchronization cancellation')).rejects.toThrow(
      'cancel repository source synchronization',
    );
    expect(sandbox.getBoundRepositoryContext()).toMatchObject({ branch: null, head_sha: null });
  });

  it('keeps the final source observation inside the repository-state mutation lock', async () => {
    const firstObservationStarted = Promise.withResolvers<void>();
    const releaseFirstObservation = Promise.withResolvers<void>();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result = params.command === BOUND_REPOSITORY_STATE_COMMAND ? '/repo\nmain\nabcdef\n' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const downloadFile = jest.fn(({ path }: { sandboxId: string; path: string }): Promise<Buffer> => {
      if (path.endsWith('AGENTS.md')) {
        return Promise.resolve(Buffer.from('repository instructions'));
      }
      return Promise.reject(new Error('missing'));
    });
    let observationCount = 0;
    const onRepositorySources = jest.fn(async (): Promise<void> => {
      observationCount += 1;
      if (observationCount === 1) {
        firstObservationStarted.resolve();
        await releaseFirstObservation.promise;
      }
    });
    const sandbox = makeSandbox(makeProvider({ exec, downloadFile }), {
      existingSandboxId: 'v1:test:raw-1',
      boundRepository,
      onRepositorySources,
    });

    const firstRefresh = sandbox.refreshBoundRepositoryState();
    await withTimeout(firstObservationStarted.promise, 500, 'first source observation');
    const secondRefresh = sandbox.refreshBoundRepositoryState();
    await Promise.resolve();
    const stateReadsBeforeRelease = exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND);
    expect(stateReadsBeforeRelease).toHaveLength(1);

    releaseFirstObservation.resolve();
    await Promise.all([firstRefresh, secondRefresh]);
    expect(exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND)).toHaveLength(2);
  });

  it('keeps the mutation queue closed when a waiting repository refresh is cancelled', async () => {
    const firstObservationStarted = Promise.withResolvers<void>();
    const releaseFirstObservation = Promise.withResolvers<void>();
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      const result = params.command === BOUND_REPOSITORY_STATE_COMMAND ? '/repo\nmain\nabcdef\n' : 'ok';
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const downloadFile = jest.fn(({ path }: { sandboxId: string; path: string }): Promise<Buffer> => {
      if (path.endsWith('AGENTS.md')) {
        return Promise.resolve(Buffer.from('repository instructions'));
      }
      return Promise.reject(new Error('missing'));
    });
    let observationCount = 0;
    const onRepositorySources = jest.fn(async (): Promise<void> => {
      observationCount += 1;
      if (observationCount === 1) {
        firstObservationStarted.resolve();
        await releaseFirstObservation.promise;
      }
    });
    const sandbox = makeSandbox(makeProvider({ exec, downloadFile }), {
      existingSandboxId: 'v1:test:raw-1',
      boundRepository,
      onRepositorySources,
    });

    const firstRefresh = sandbox.refreshBoundRepositoryState();
    await withTimeout(firstObservationStarted.promise, 500, 'first locked source observation');
    const controller = new AbortController();
    const cancelledRefresh = sandbox.refreshBoundRepositoryState({ signal: controller.signal });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    controller.abort(new Error('cancel queued refresh'));
    await expect(withTimeout(cancelledRefresh, 500, 'queued refresh cancellation')).rejects.toThrow(
      'cancel queued refresh',
    );

    const finalRefresh = sandbox.refreshBoundRepositoryState();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND)).toHaveLength(1);

    releaseFirstObservation.resolve();
    await Promise.all([firstRefresh, finalRefresh]);
    expect(exec.mock.calls.filter(call => call[0].command === BOUND_REPOSITORY_STATE_COMMAND)).toHaveLength(2);
  });

  it('defaults exec cwd to the bound repository', async () => {
    const exec = jest.fn((params: SandboxExecParams) => {
      void params;
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ exec, getWorkspaceDir: () => '/prov/workspace' }), { boundRepository });
    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Inspect status', purpose: 'inspect', command: 'git status --short' },
    };

    const info = await sandbox.toolCallInfo(call);

    expect(info.original_tool_name).toBe(
      sandboxCommandApprovalIdentity({ purpose: 'inspect', command: 'git status --short', cwd: '/repo', env: {} }),
    );

    await sandbox.callTool(call, { status: 'allow', scope: 'once' });

    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ command: 'git status --short', cwd: '/repo' }));
    expect(exec.mock.calls.some(([params]) => params.command.includes("'/prov/workspace'"))).toBe(false);
  });

  it('defaults unbound repository work to the provider-owned writable workspace', async () => {
    const exec = jest.fn((params: SandboxExecParams) => {
      void params;
      return readyExec();
    });
    const sandbox = makeSandbox(
      makeProvider({
        exec,
        getWorkspaceDir: () => '/prov/workspace',
      }),
    );

    const call = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Clone the repository',
        purpose: 'execute',
        command: 'git clone https://github.com/example/project.git project',
      },
    };
    const info = await sandbox.toolCallInfo(call);

    expect(info.original_tool_name).toBe(
      sandboxCommandApprovalIdentity({
        purpose: 'execute',
        command: 'git clone https://github.com/example/project.git project',
        cwd: '/prov/workspace',
        env: {},
      }),
    );

    await sandbox.callTool(call, { status: 'allow', scope: 'once' });

    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'git clone https://github.com/example/project.git project',
        cwd: '/prov/workspace',
      }),
    );
    expect(exec.mock.calls.some(call => call[0].command.includes("'/prov/workspace'"))).toBe(true);

    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    expect(builder.build()).toContain('unbound_workspace_cwd: /prov/workspace');
    expect(builder.build()).toContain('pass the child checkout path as cwd');
  });

  it('instructs the model to batch discovery into one command instead of one inspection per step', () => {
    const sandbox = makeSandbox(makeProvider({}), { boundRepository });

    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();

    expect(prompt).toContain('Batch discovery inside one command');
    expect(prompt).toContain('sed -n 1,80p a.ts; echo ----; sed -n 1,80p b.ts');
    expect(prompt).toContain("rg -n 'nameA|nameB|nameC' src");
    expect(prompt).toContain('rg --files | rg pattern');
    expect(prompt).toContain('counts toward the host');
  });

  it('flags open_world_hint for an exec call that names a network client, without changing approval', async () => {
    const sandbox = makeSandbox(makeProvider({}), { boundRepository });

    const networkInfo = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Fetch a URL', purpose: 'execute', command: 'curl https://example.com/data.json' },
    });
    expect(networkInfo.open_world_hint).toBe(true);
    expect(networkInfo.effect).toBe('execute');
    expect(networkInfo.is_approval_required).toBe(true);

    const localInfo = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Inspect status', purpose: 'inspect', command: 'git status --short' },
    });
    expect(localInfo.open_world_hint).toBeUndefined();
  });

  it('runs a registered command by ID with host-owned command, cwd, and timeout', async () => {
    const verificationOutput = [
      ...Array.from({ length: 130 }, (_, index) => `build progress line ${String(index)}`),
      'src/App.tsx(1,10): error TS2305: missing export',
    ].join('\n');
    const exec = makeVerificationExec({
      verificationCommand: 'pnpm verify',
      verificationResult: { success: true, response: { exitCode: 0, result: verificationOutput } },
      afterState: {},
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });

    const response = await sandbox.callTool(
      {
        name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
        arguments: { intent: 'Verify the repository', command_id: 'verify' },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    if (!isCallToolResponseResult(response)) throw new Error('Expected a registered-command tool result');
    expect(response.verificationReceiptCandidate).toBeDefined();
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'pnpm verify', cwd: '/repo', timeoutSeconds: 900 }),
    );
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected a text tool result');
    const serialized = JSON.parse(content.text);
    expect(serialized.response.result).not.toContain('build progress line 0');
    expect(serialized.response.result).toContain('build progress line 129');
    expect(serialized.response.result).toContain('error TS2305: missing export');
    expect(serialized.raw_output).toMatchObject({
      storage_status: 'stored',
      byte_length: Buffer.byteLength(verificationOutput),
    });
  });

  it('attaches durable command metadata only to the registered-command tool', async () => {
    const sandbox = makeSandbox(makeProvider(), { boundRepository });

    const registered = await sandbox.toolCallInfo({
      name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
      arguments: { intent: 'Verify', command_id: 'verify' },
    });
    const ordinaryExec = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Inspect',
        purpose: 'inspect',
        command: 'git status --short',
        command_id: 'verify',
      },
    });

    expect(registered.command_execution).toMatchObject({ command_id: 'verify', timeout_ms: 900_000 });
    expect(ordinaryExec.command_execution).toBeUndefined();
  });

  it('keeps the registered repository cwd across fifty reconstructed turns', async () => {
    for (let turn = 0; turn < 50; turn += 1) {
      const exec = makeVerificationExec({
        verificationCommand: 'pnpm verify',
        verificationResult: { success: true, response: { exitCode: 0, result: `green-${turn}` } },
        afterState: {},
      });
      const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });

      const response = await sandbox.callTool(
        {
          name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
          arguments: { intent: 'Verify the repository', command_id: 'verify' },
        },
        { status: 'allow', scope: 'once' },
      );

      expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
      expect(exec).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'pnpm verify', cwd: '/repo', timeoutSeconds: 900 }),
      );
    }
  });

  it('rejects unknown registered command IDs without dispatch', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }), { boundRepository });

    const response = await sandbox.callTool({
      name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
      arguments: { intent: 'Run a check', command_id: 'missing' },
    });

    expect(JSON.stringify(response)).toContain('Unknown registered command');
    expect(exec).not.toHaveBeenCalled();
  });

  it('names cwd and repository binding when an unbound verification has neither', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));

    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Verify the repository', purpose: 'verify', command: 'pnpm verify' },
    });

    expect(JSON.stringify(response)).toContain('cwd');
    expect(JSON.stringify(response)).toContain('repository binding');
    expect(exec).not.toHaveBeenCalled();
  });

  it('runs a verify-purpose command without a bound repository instead of failing with a durable verification error', async () => {
    const command = 'echo $HOME && pwd && ls -la /opt/tf/workspace/ || echo none';
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Inspect the workspace', purpose: 'verify', cwd: '/workspace/checkout', command },
      },
      { status: 'allow', scope: 'once' },
    );

    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(false);
    expect(JSON.stringify(response)).not.toContain('Durable repository verification is unavailable');
    expect(response.verificationReceiptCandidate).toBeUndefined();
    expect(exec.mock.calls.some(call => call[0].command === command)).toBe(true);
  });

  it('runs a commit-purpose command without a bound repository instead of failing with a durable verification error', async () => {
    const command = 'git commit -m "wip"';
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Commit local changes', purpose: 'commit', cwd: '/workspace/checkout', command },
      },
      { status: 'allow', scope: 'once' },
    );

    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(false);
    expect(JSON.stringify(response)).not.toContain('Durable repository verification is unavailable');
    expect(response.verificationReceiptCandidate).toBeUndefined();
    expect(exec.mock.calls.some(call => call[0].command === command)).toBe(true);
  });

  it('does not replay an unbound commit after a provider disconnect leaves its outcome uncertain', async () => {
    const command = 'git commit -m "wip"';
    let commandAttempts = 0;
    const createSandbox = jest.fn(() => Promise.resolve({ sandboxId: 'replacement' }));
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === command) {
        commandAttempts += 1;
        throw new SandboxNotAvailableError(params.sandboxId);
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ createSandbox, exec }), {
      existingSandboxId: 'v1:test:existing',
    });

    await expect(
      sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Commit local changes', purpose: 'commit', cwd: '/workspace/checkout', command },
        },
        { status: 'allow', scope: 'once' },
      ),
    ).rejects.toBeInstanceOf(SandboxNotAvailableError);

    expect(commandAttempts).toBe(1);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('recreates a lost sandbox and retries an unbound commit when workspace-root discovery fails before dispatch', async () => {
    const command = 'git commit -m "wip"';
    let discoveryAttempts = 0;
    let commandAttempts = 0;
    const createSandbox = jest.fn(() => Promise.resolve({ sandboxId: 'replacement' }));
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'git rev-parse --show-toplevel') {
        discoveryAttempts += 1;
        if (discoveryAttempts === 1) {
          throw new SandboxNotAvailableError(params.sandboxId);
        }
        return readyExec();
      }
      if (params.command === command) {
        commandAttempts += 1;
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ createSandbox, exec }), {
      existingSandboxId: 'v1:test:existing',
    });

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Commit local changes', purpose: 'commit', cwd: '/workspace/checkout', command },
      },
      { status: 'allow', scope: 'once' },
    );

    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    expect(response.result.isError).toBe(false);
    // Workspace-root discovery never reached the target command, so the lost
    // sandbox is safe to recreate: discovery is retried in the replacement
    // sandbox and the commit dispatches there exactly once.
    expect(discoveryAttempts).toBe(2);
    expect(commandAttempts).toBe(1);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it('snapshots staged documents through bounded immutable bytes and validates page limits before execution', async () => {
    const downloadFile = jest.fn(() => Promise.resolve(Buffer.from('safe')));
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('realpath -e --')) {
        const path = params.command.includes('document.pdf') ? '/prov/uploads/document.pdf' : '/prov/uploads';
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${path}\n` } });
      }
      const marker = /AMAN_DOCUMENT_SNAPSHOT_[0-9a-f]+/.exec(params.command)?.[0];
      if (marker !== undefined) {
        const hash = createHash('sha256').update('safe').digest('hex');
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${marker}:OK:4:${hash}\n` } });
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ downloadFile, exec }));

    const snapshot = await sandbox.createDocumentSnapshot({ filePath: '/prov/uploads/document.pdf', maxBytes: 4 });

    expect(snapshot.content).toEqual(Buffer.from('safe'));
    expect(snapshot.filePath).toMatch(/^\/prov\/uploads\/\.amanuensis-document-/);
    expect(exec.mock.calls.some(call => call[0].command.includes('exec 3<'))).toBe(true);
    expect(exec.mock.calls.some(call => call[0].command.includes('head -c 4'))).toBe(true);
    expect(exec.mock.calls.some(call => call[0].command.includes('sha256sum /proc/self/fd/3'))).toBe(true);
    expect(exec.mock.calls.some(call => call[0].command.includes('case \"$opened_path\"'))).toBe(true);
    await snapshot.verify();
    await snapshot.cleanup();
    expect(downloadFile).toHaveBeenCalledTimes(2);

    exec.mockClear();
    await expect(sandbox.runDocumentText({ filePath: '/prov/uploads/document.pdf', maxPages: 1.5 })).rejects.toThrow(
      'Document page limit must be an integer',
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('removes a remote document snapshot when its initial download fails', async () => {
    const hash = createHash('sha256').update('safe').digest('hex');
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('realpath -e --')) {
        const path = params.command.includes('document.pdf') ? '/prov/uploads/document.pdf' : '/prov/uploads';
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${path}\n` } });
      }
      const marker = /AMAN_DOCUMENT_SNAPSHOT_[0-9a-f]+/.exec(params.command)?.[0];
      return marker === undefined
        ? readyExec()
        : Promise.resolve({ success: true, response: { exitCode: 0, result: `${marker}:OK:4:${hash}\n` } });
    });
    const downloadFile = jest.fn(() => Promise.reject(new Error('provider download failed')));
    const sandbox = makeSandbox(makeProvider({ downloadFile, exec }));

    await expect(
      sandbox.createDocumentSnapshot({ filePath: '/prov/uploads/document.pdf', maxBytes: undefined }),
    ).rejects.toThrow('provider download failed');

    expect(exec.mock.calls.some(call => /^rm -f -- .*\/\.amanuensis-document-[0-9a-f]+/.test(call[0].command))).toBe(
      true,
    );
  });

  it('runs bounded OCR without masking Tesseract failures behind head', async () => {
    const ocrCommands: string[] = [];
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('realpath -e --')) {
        const path = params.command.includes('document.') ? '/prov/uploads/document.pdf' : '/prov/uploads';
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${path}\n` } });
      }
      const marker = /AMAN_OCR_PAGE_[0-9a-f]+/.exec(params.command)?.[0];
      if (marker !== undefined) {
        ocrCommands.push(params.command);
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${marker}:1\ntext\n` } });
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ exec }));

    await sandbox.runDocumentOcr({
      filePath: '/prov/uploads/document.png',
      kind: 'image',
      pages: undefined,
      maxPages: 1,
    });
    await sandbox.runDocumentOcr({
      filePath: '/prov/uploads/document.pdf',
      kind: 'pdf',
      pages: [1],
      maxPages: 1,
    });
    await sandbox.runDocumentOcr({
      filePath: '/prov/uploads/document.pdf',
      kind: 'pdf',
      pages: undefined,
      maxPages: 1,
    });

    expect(ocrCommands).toHaveLength(3);
    for (const command of ocrCommands) {
      // The page is read into a file and then cut, so a Tesseract failure is not hidden behind head.
      expect(command).not.toMatch(/--psm 6 [^;]*\|/);
      expect(command).toMatch(/tesseract [^;]+ --psm 6 > "\$raw_text_file"; head -c/);
      expect(command).toContain('export OMP_THREAD_LIMIT=1');
    }
  });

  it('rejects a non-zero OCR command instead of returning an empty page', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('realpath -e --')) {
        const path = params.command.includes('document.png') ? '/prov/uploads/document.png' : '/prov/uploads';
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${path}\n` } });
      }
      if (params.command.includes('tesseract ')) {
        return Promise.resolve({ success: true, response: { exitCode: 1, result: 'tesseract failed' } });
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ exec }));

    await expect(
      sandbox.runDocumentOcr({
        filePath: '/prov/uploads/document.png',
        kind: 'image',
        pages: undefined,
        maxPages: 1,
      }),
    ).rejects.toThrow('(exit code 1): tesseract failed');
  });

  it('picks OCR languages per page and falls back to the configured ones', async () => {
    const ocrCommands: string[] = [];
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('realpath -e --')) {
        const path = params.command.includes('document.') ? '/prov/uploads/document.pdf' : '/prov/uploads';
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${path}\n` } });
      }
      const marker = /AMAN_OCR_PAGE_[0-9a-f]+/.exec(params.command)?.[0];
      if (marker !== undefined) {
        ocrCommands.push(params.command);
        return Promise.resolve({ success: true, response: { exitCode: 0, result: `${marker}:1\ntext\n` } });
      }
      return readyExec();
    });
    const sandbox = makeSandbox(makeProvider({ exec }), { ocrLanguages: 'deu fra' });

    await sandbox.runDocumentOcr({
      filePath: '/prov/uploads/document.pdf',
      kind: 'pdf',
      pages: [1],
      maxPages: 1,
    });

    expect(ocrCommands).toHaveLength(1);
    expect(ocrCommands[0]).toMatch(/tesseract\s+"[^"]+\.png"\s+stdout\s+--psm\s+0/);
    expect(ocrCommands[0]).toContain("*) wanted='deu fra';;");
    expect(ocrCommands[0]).toMatch(/tesseract\s+"[^"]+\.png"\s+stdout\s+-l\s+"\$ocr_languages"\s+--psm\s+6/);
  });

  it('exposes apply_patch as a structured approval-gated edit', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const provider = makeProvider({ exec });
    const sandbox = makeSandbox(provider);
    const listed = await sandbox.listTools();
    const tool = listed.result.tools.find(candidate => candidate.name === SANDBOX_APPLY_PATCH_TOOL_NAME);
    // `patch` and its `patch_lines` array sibling are each optional at the JSON Schema level:
    // "exactly one of the pair" is a runtime refinement Zod enforces at parse time, not something
    // JSON Schema's `required` can express for a pair, so only `intent`/`cwd` are unconditionally
    // required, and both `patch` and `patch_lines` are advertised as accepted properties.
    expect(tool?.inputSchema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['intent', 'cwd']),
        properties: expect.objectContaining({
          patch: expect.objectContaining({ type: 'string' }),
          patch_lines: expect.objectContaining({ type: 'array' }),
        }),
      }),
    );

    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: {
        intent: 'Fix reconnect handling',
        cwd: '/repo',
        patch: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n',
      },
    };
    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(
      expect.objectContaining({
        effect: 'edit',
        is_approval_required: true,
        original_tool_name: 'apply_patch:edit',
      }),
    );
    const response = await sandbox.callTool(call);
    expect(response).toHaveProperty('approvalRequired');
    expect(provider.uploadFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('advertises a <field>_lines array sibling for every multi-line structured-edit field, and guides models toward it', async () => {
    // See toolArgumentNormalization.ts: a model reliably produces one array element per line but
    // unreliably produces embedded "\n" inside a single JSON string value. Every structured-edit
    // tool's schema and description must say so, so a model reaches for the array form.
    const sandbox = makeSandbox(makeProvider());
    const listed = await sandbox.listTools();
    const guidanceFragment = 'one element per line, blank lines as empty strings';

    const applyPatchTool = listed.result.tools.find(candidate => candidate.name === SANDBOX_APPLY_PATCH_TOOL_NAME);
    expect(applyPatchTool?.description).toContain(guidanceFragment);
    expect(applyPatchTool?.inputSchema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['intent', 'cwd']),
        properties: expect.objectContaining({
          patch: expect.objectContaining({ type: 'string' }),
          patch_lines: expect.objectContaining({ type: 'array', items: { type: 'string' } }),
        }),
      }),
    );
    expect(applyPatchTool?.inputSchema).not.toEqual(
      expect.objectContaining({ required: expect.arrayContaining(['patch']) }),
    );
    expect(applyPatchTool?.inputSchema).not.toEqual(
      expect.objectContaining({ required: expect.arrayContaining(['patch_lines']) }),
    );

    const replaceTextTool = listed.result.tools.find(candidate => candidate.name === SANDBOX_REPLACE_TEXT_TOOL_NAME);
    expect(replaceTextTool?.description).toContain(guidanceFragment);
    expect(replaceTextTool?.inputSchema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['intent', 'cwd', 'path']),
        properties: expect.objectContaining({
          old_text: expect.objectContaining({ type: 'string' }),
          old_text_lines: expect.objectContaining({ type: 'array', items: { type: 'string' } }),
          new_text: expect.objectContaining({ type: 'string' }),
          new_text_lines: expect.objectContaining({ type: 'array', items: { type: 'string' } }),
        }),
      }),
    );
    expect(replaceTextTool?.inputSchema).not.toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['old_text', 'old_text_lines', 'new_text', 'new_text_lines']),
      }),
    );

    const writeFileTool = listed.result.tools.find(candidate => candidate.name === SANDBOX_WRITE_FILE_TOOL_NAME);
    expect(writeFileTool?.description).toContain(guidanceFragment);
    expect(writeFileTool?.inputSchema).toEqual(
      expect.objectContaining({
        required: expect.arrayContaining(['intent', 'path']),
        properties: expect.objectContaining({
          content: expect.objectContaining({ type: 'string' }),
          content_lines: expect.objectContaining({ type: 'array', items: { type: 'string' } }),
        }),
      }),
    );
    expect(writeFileTool?.inputSchema).not.toEqual(
      expect.objectContaining({ required: expect.arrayContaining(['content', 'content_lines']) }),
    );
  });

  it('uploads patch bytes and checks the patch before applying it', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new; $(ignored)\n';
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: { intent: 'Update a line', cwd: '/repo', patch },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        content: Buffer.from(patch.replace('@@ -1 +1 @@', '@@ -1,1 +1,1 @@'), 'utf-8'),
      }),
    );
    const patchCalls = exec.mock.calls.map(call => call[0]).filter(call => call.command.includes('git apply'));
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]).toEqual(expect.objectContaining({ cwd: '/repo' }));
    expect(patchCalls[0]?.command).toContain('git apply --recount --unidiff-zero --check');
    expect(patchCalls[1]?.command).toContain('git apply --recount --');
    expect(patchCalls.map(call => call.command).join('\n')).not.toContain('$(ignored)');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
  });

  it('tells the model the required patch shape and that the target must already exist when git apply --check fails', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.includes('--check')) {
        return Promise.resolve({
          success: true,
          response: { exitCode: 1, result: 'error: a.txt: No such file or directory' },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: { intent: 'Update a line', cwd: '/repo', patch },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    if (!isCallToolResponseResult(response)) {
      throw new Error('Expected a resolved call_tool response');
    }
    expect(response.result.isError).toBe(true);
    const first = response.result.content[0];
    if (first === undefined || first.type !== 'text') {
      throw new Error('Expected text content');
    }
    const parsed = JSON.parse(first.text) as { hint?: string; check?: unknown };
    expect(parsed.hint).toBe(APPLY_PATCH_CHECK_FAILURE_HINT);
    expect(parsed.check).toEqual(
      expect.objectContaining({ success: true, response: expect.objectContaining({ exitCode: 1 }) }),
    );
  });

  it('repairs only stale hunk counts before validating a model-authored patch', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n old\n+second\n third\n';
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: { intent: 'Add a line', cwd: '/repo', patch },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    const uploaded = uploadFile.mock.calls[0]?.[0] as { content: Buffer } | undefined;
    expect(uploaded?.content.toString('utf-8')).toContain('@@ -1,2 +1,3 @@');
    expect(uploaded?.content.toString('utf-8')).toContain(' old\n+second\n third');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
  });

  it('converts an OpenAI-format apply_patch envelope to a git diff and applies it with exact offsets', async () => {
    // gpt-oss (and other harmony-format models) emit apply_patch calls in OpenAI's own
    // "*** Begin Patch" envelope even when the tool description asks for a git unified diff.
    // The host must convert this to a git diff, computing real hunk offsets from the sandbox
    // file's current content, rather than reject it and fall back to unstructured shell edits.
    const originalContent = 'export function add(a, b) {\n  return a + b;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'a.txt': Buffer.from(originalContent, 'utf-8').toString('base64') }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-export function add(a, b) {',
      '-  return a + b;',
      '-}',
      '+/** Adds two numbers. */',
      '+export function add(a, b) {',
      '+  return a + b;',
      '+}',
      '*** End Patch',
      '',
    ].join('\n');
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: { intent: 'Document add()', cwd: '/repo', patch },
    };

    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    const uploaded = uploadFile.mock.calls[0]?.[0] as { content: Buffer } | undefined;
    const uploadedText = uploaded?.content.toString('utf-8');
    expect(uploadedText).toContain('diff --git a/a.txt b/a.txt');
    expect(uploadedText).toContain('--- a/a.txt');
    expect(uploadedText).toContain('+++ b/a.txt');
    // The context/removed lines exactly match the start of the sandbox file's real content, so
    // the converter locates them at line 1 rather than falling back to the placeholder offset.
    expect(uploadedText).toContain('@@ -1,3 +1,4 @@');
    expect(uploadedText).toContain(
      '-export function add(a, b) {\n-  return a + b;\n-}\n+/** Adds two numbers. */\n+export function add(a, b) {\n+  return a + b;\n+}',
    );
    const patchCalls = exec.mock.calls
      .map(callArgs => callArgs[0])
      .filter(callArgs => callArgs.command.includes('git apply'));
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]?.command).toContain('git apply --recount --unidiff-zero --check');
    expect(patchCalls[1]?.command).toContain('git apply --recount --');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
  });

  it('reads OpenAI-format apply_patch content paths relative to cwd, not the workspace root', async () => {
    // structuredEditPaths interprets a raw OpenAI patch path ("a.txt") as relative to the
    // requested cwd. When the sandbox cwd is nested below the Git toplevel, the file the exact-
    // offset converter must read is <toplevel>/<cwd-relative>/a.txt, not <toplevel>/a.txt.
    const rootContent = 'export const value = "wrong file";\n';
    const nestedContent = 'export function add(a, b) {\n  return a + b;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'git rev-parse --show-toplevel') {
        return Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo' } });
      }
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        const content = params.command.includes('"sub/a.txt"') ? nestedContent : rootContent;
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({
              [params.command.includes('"sub/a.txt"') ? 'sub/a.txt' : 'a.txt']: Buffer.from(content, 'utf-8').toString(
                'base64',
              ),
            }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-export function add(a, b) {',
      '-  return a + b;',
      '-}',
      '+/** Adds two numbers. */',
      '+export function add(a, b) {',
      '+  return a + b;',
      '+}',
      '*** End Patch',
      '',
    ].join('\n');
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: { intent: 'Document add()', cwd: '/repo/sub', patch },
    };

    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    // The read must target the nested file: the request sent to the sandbox names the
    // repository-relative path, not the raw patch path.
    expect(
      exec.mock.calls.some(
        callArgs => callArgs[0].command.includes('base64') && callArgs[0].command.includes('"sub/a.txt"'),
      ),
    ).toBe(true);
    const uploaded = uploadFile.mock.calls[0]?.[0] as { content: Buffer } | undefined;
    const uploadedText = uploaded?.content.toString('utf-8');
    // Exact offsets computed from the nested file's real content, not the placeholder and not the
    // wrong (workspace-root) file's content.
    expect(uploadedText).toContain('@@ -1,3 +1,4 @@');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
  });

  it('rejects an apply_patch that mixes the OpenAI envelope with a git diff header', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const patch =
      '*** Begin Patch\n*** Update File: a.txt\n@@\ndiff --git a/a.txt b/a.txt\n-old\n+new\n*** End Patch\n';
    const response = await sandbox.callTool(
      { name: SANDBOX_APPLY_PATCH_TOOL_NAME, arguments: { intent: 'Bad patch', cwd: '/repo', patch } },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toMatch(/mixes|embeds/i);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(callArgs => callArgs[0].command.includes('git apply'))).toBe(false);
  });

  it('rejects ambiguous plain multi-file diffs instead of corrupting their hunk boundaries', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: {
          intent: 'Edit two files',
          cwd: '/repo',
          patch: '--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-old\n+new\n--- b.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new\n',
        },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('Git-format unified diff');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(call => call[0].command.includes('git apply'))).toBe(false);
  });

  it('sends exact text replacements as data through one approval-gated edit', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Fix reconnect handling',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'break;',
        new_text: 'yield update;\nbreak;',
      },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(
      expect.objectContaining({ effect: 'edit', is_approval_required: true, original_tool_name: 'replace_text:edit' }),
    );
    await expect(sandbox.callTool(call)).resolves.toHaveProperty('approvalRequired');
    expect(exec).not.toHaveBeenCalled();

    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });
    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    const uploadedPayload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0] as
      { content: Buffer } | undefined;
    const uploadedScript = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.py'))?.[0] as
      { content: Buffer } | undefined;
    expect(JSON.parse(uploadedPayload?.content.toString('utf-8') ?? '{}')).toEqual(
      expect.objectContaining({ path: 'src/runtime.ts', old_text: 'break;', new_text: 'yield update;\nbreak;' }),
    );
    expect(uploadedScript?.content.toString('utf-8')).toContain('os.O_NOFOLLOW');
    expect(uploadedScript?.content.toString('utf-8')).toContain('src_dir_fd=parent_fd');
    expect(uploadedScript?.content.toString('utf-8')).toContain('replacement would not change the file');
    const executed = exec.mock.calls
      .map(callArgs => callArgs[0])
      .find(params => params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c '));
    expect(executed?.cwd).toBe('/repo');
    expect(executed?.command).toMatch(/^python3 -I -S '.*\.py' '.*\.json'$/);
    expect(executed?.command).not.toContain('yield update');
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
  });

  it('proceeds unchanged when old_text matches the current file content exactly once', async () => {
    const fileContent = 'function reconnect() {\n  break;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Fix reconnect handling',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'break;',
        new_text: 'yield update;\nbreak;',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    const uploadedPayload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0] as
      { content: Buffer } | undefined;
    expect(JSON.parse(uploadedPayload?.content.toString('utf-8') ?? '{}')).toEqual(
      expect.objectContaining({ old_text: 'break;' }),
    );
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    expect(JSON.stringify(response)).not.toContain('"note"');
  });

  it('rejects without dispatching, with a nearest-passage diagnostic, when old_text differs only by whitespace', async () => {
    // Previously this was fuzzy-matched and applied with a note; the host must now reject it —
    // it never guesses — and point at the real (tab-indented) passage instead of substituting it.
    const fileContent = 'function connect() {\n  if (down) {\n\t\tbreak;\n  }\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Add a log line before breaking',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: '  if (down) {\n  break;\n  }',
        new_text: '  if (down) {\n  log();\n  break;\n  }',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('received');
    expect(JSON.stringify(response)).toContain('expected');
    expect(JSON.stringify(response)).toContain('Nearest passage in src/runtime.ts');
    expect(uploadFile.mock.calls.some(callArgs => callArgs[0].remotePath.endsWith('.json'))).toBe(false);
    expect(exec.mock.calls.some(callArgs => /^python3 '.*\.py' '.*\.json'$/.test(callArgs[0].command))).toBe(false);
  });

  it('rejects replace_text without dispatching when old_text matches more than one location', async () => {
    const fileContent = 'function f() {\n  return 1;\n}\nfunction g() {\n  return 1;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Change the return value',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'return 1;',
        new_text: 'return 2;',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('matches 2 locations');
    expect(uploadFile.mock.calls.some(callArgs => callArgs[0].remotePath.endsWith('.json'))).toBe(false);
    expect(exec.mock.calls.some(callArgs => /^python3 '.*\.py' '.*\.json'$/.test(callArgs[0].command))).toBe(false);
  });

  it('dispatches replace_text when old_text matches more than one location and replace_all is true', async () => {
    const fileContent = 'function f() {\n  return 1;\n}\nfunction g() {\n  return 1;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Change every return value',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'return 1;',
        new_text: 'return 2;',
        replace_all: true,
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    const uploadedPayload = uploadFile.mock.calls.find(callArgs => callArgs[0].remotePath.endsWith('.json'))?.[0] as
      { content: Buffer } | undefined;
    expect(JSON.parse(uploadedPayload?.content.toString('utf-8') ?? '{}')).toEqual(
      expect.objectContaining({ old_text: 'return 1;', new_text: 'return 2;', replace_all: true }),
    );
  });

  it('rejects replace_text without dispatching when old_text has no acceptable match', async () => {
    const fileContent = 'function f() {\n  return 1;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Change something that is not there',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'return 42;',
        new_text: 'return 43;',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('received');
    expect(JSON.stringify(response)).toContain('expected');
    expect(uploadFile.mock.calls.some(callArgs => callArgs[0].remotePath.endsWith('.json'))).toBe(false);
    expect(exec.mock.calls.some(callArgs => /^python3 '.*\.py' '.*\.json'$/.test(callArgs[0].command))).toBe(false);
  });

  it("surfaces the replace script's own {error: string} JSON output at the top level", async () => {
    const fileContent = 'function f() {\n  return 1;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      if (params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c ')) {
        return Promise.resolve({
          success: true,
          response: { exitCode: 1, result: JSON.stringify({ error: 'replacement would not change the file' }) },
        });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Change the return value',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'return 1;',
        new_text: 'return 1;',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('replacement would not change the file');
  });

  it('falls back to a generic rejection when the failed script output is not a {error: string} shape', async () => {
    const fileContent = 'function f() {\n  return 1;\n}\n';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command.startsWith('python3 -I -S -c ') && params.command.includes('base64')) {
        return Promise.resolve({
          success: true,
          response: {
            exitCode: 0,
            result: JSON.stringify({ 'src/runtime.ts': Buffer.from(fileContent, 'utf-8').toString('base64') }),
          },
        });
      }
      if (params.command.startsWith('python3 ') && !params.command.startsWith('python3 -I -S -c ')) {
        // Neither a string `error`, nor JSON at all in the second call — both must be handled
        // without throwing out of the `hasStringErrorProperty` narrowing.
        return Promise.resolve({ success: true, response: { exitCode: 1, result: JSON.stringify({ error: 42 }) } });
      }
      return readyExec();
    });
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Change the return value',
        cwd: '/repo',
        path: 'src/runtime.ts',
        old_text: 'return 1;',
        new_text: 'return 1;',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('received');
    expect(JSON.stringify(response)).toContain('expected');
  });

  it('rejects direct Git metadata replacement without requesting approval', async () => {
    const exec = jest.fn((_params: SandboxExecParams): Promise<ExecResult> => readyExec());
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const sandbox = makeSandbox(makeProvider({ exec, uploadFile }));
    const call = {
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      arguments: {
        intent: 'Create a branch',
        cwd: '/repo',
        path: '.git/HEAD',
        old_text: 'ref: refs/heads/main',
        new_text: 'ref: refs/heads/task',
      },
    };

    await expect(sandbox.toolCallInfo(call)).resolves.toEqual(
      expect.objectContaining({ effect: 'edit', is_approval_required: false }),
    );
    const response = await sandbox.callTool(call);
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('cannot modify Git metadata');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not apply a patch that fails validation', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      params.command.startsWith('python3 -I -S -c ')
        ? Promise.resolve({
            success: true,
            response: {
              exitCode: 0,
              result: JSON.stringify({
                kind: 'apply_patch',
                targets: [{ path: 'a', state: 'present', byte_length: 3, sha256: 'b'.repeat(64) }],
              }),
            },
          })
        : params.command === 'git rev-parse --show-toplevel'
          ? Promise.resolve({ success: true, response: { exitCode: 0, result: '/repo' } })
          : Promise.resolve(
              params.command.includes('git apply --recount --unidiff-zero --check')
                ? { success: true, response: { exitCode: 1, result: 'patch does not apply' } }
                : { success: true, response: { exitCode: 0, result: '' } },
            ),
    );
    const sandbox = makeSandbox(makeProvider({ exec }));
    const call = {
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      arguments: {
        intent: 'Update a line',
        cwd: '/repo',
        patch: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n',
      },
    };
    const context = await structuredEditContext(sandbox, call, {
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
    });

    const response = await sandbox.callTool(call, { status: 'allow', scope: 'once' }, context);

    expect(exec.mock.calls.filter(call => call[0].command.includes('git apply'))).toHaveLength(1);
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
  });

  it('puts the provider uploads dir in the system prompt, not /tmp/uploads', () => {
    const sandbox = makeSandbox(makeProvider());
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();
    expect(prompt).toContain('/prov/uploads/');
    expect(prompt).not.toContain('/tmp/uploads');
    expect(prompt).toContain('work from a checked-out repository');
    expect(prompt).toContain('no more than eight inspection calls');
    expect(prompt).toContain('has no authoritative persisted model');
    expect(prompt).toContain('A commit and a push are separate consequential actions');
    expect(prompt).toContain('Setting HOME does not change the working directory');
    expect(prompt).toContain(
      'Before reading a file by path, confirm it exists with a listing or a search (ls, find, grep -l, rg -l) unless a previous result in this session already showed that path.',
    );
    expect(prompt).toContain('Do not guess paths from component names.');
    expect(prompt).toContain(
      'Before each tool call, write one short sentence in your visible reply stating what you are about to do and why.',
    );
    expect(prompt).toContain('Put it in the answer, not in reasoning.');
    const locateIndex = prompt.indexOf('Before reading a file by path, confirm it exists');
    const progressIndex = prompt.indexOf('Before each tool call, write one short sentence');
    expect(locateIndex).toBeGreaterThan(-1);
    expect(progressIndex).toBeGreaterThan(locateIndex);
  });

  it('does not add the locate-before-opening or visible-progress guidance for a non-sandbox session', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
    async function* finalAnswerStream(): AsyncGenerator<
      ExtendedChatCompletionChunk,
      RawAssistantMessageWithUsage,
      unknown
    > {
      yield {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      };
      return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
    }
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    // No `sandbox` is passed to the thread: this exercises the real conditional path in
    // AgentThread's prompt builder (`if (this.sandbox) { this.sandbox.buildInstruction(...) }`)
    // rather than asserting against an untouched, always-empty InstructionBuilder.
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelId: undefined, configuredModels: undefined, modelClient, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'What should I do first?' }],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Draining is enough; the assertion is on the request sent to the model.
    }

    const request = create.mock.calls[0]?.[0];
    const systemMessage = request?.messages.find(m => m.role === 'system');
    expect(systemMessage?.content).not.toContain('Before reading a file by path, confirm it exists');
    expect(systemMessage?.content).not.toContain('Before each tool call, write one short sentence');
  });

  it('keeps commit and push approvals in separate grant scopes', () => {
    expect(sandboxCommandEffect('pnpm test')).toBe('execute');
    expect(sandboxCommandEffect('git commit -m "fix"')).toBe('commit');
    expect(sandboxCommandEffect('git -c push.default=current push origin HEAD')).toBe('push');
    const testIdentity = sandboxCommandApprovalIdentity({
      purpose: 'verify',
      command: 'pnpm test',
      cwd: '/repo',
      env: {},
    });
    expect(testIdentity).toBe(testIdentity);
    expect(
      sandboxCommandApprovalIdentity({ purpose: 'verify', command: 'pnpm build', cwd: '/repo', env: {} }),
    ).not.toBe(testIdentity);
  });

  it('passes an arbitrary non-mutating verification command and preserves its output', async () => {
    const command = './scripts/validate.sh';
    const exec = makeVerificationExec({
      verificationCommand: command,
      verificationResult: {
        success: true,
        response: { exitCode: 0, result: 'complete stdout\ncomplete stderr' },
      },
      afterState: {},
    });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected text tool output');
    expect(content.text).toContain('complete stdout\\ncomplete stderr');
    expect(content.text).toContain('"passed":true');
    expect(response.verificationReceiptCandidate).toBeDefined();
    expect(exec.mock.calls.filter(call => call[0].command === command)).toHaveLength(1);
  });

  it.each([
    {
      name: 'tracked worktree',
      afterState: { [TRACKED_WORKTREE_COMMAND]: APP_CHANGED_LISTING },
    },
    {
      name: 'staged index',
      afterState: { [GIT_INDEX_ENTRIES_COMMAND]: `100644 ${'4'.repeat(40)} 0\tsrc/app.ts\0` },
    },
    { name: 'HEAD', afterState: { 'git rev-parse HEAD': 'fedcba9876543210' } },
    {
      name: 'unignored untracked file',
      afterState: {
        'git ls-files --others --exclude-standard -z': 'generated.ts\0',
        "git hash-object --no-filters -- 'generated.ts'": 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    },
  ])('fails verification after a $name mutation', async ({ afterState }) => {
    const command = 'custom-project-check';
    const exec = makeVerificationExec({
      verificationCommand: command,
      verificationResult: { success: true, response: { exitCode: 0, result: 'check passed' } },
      afterState,
    });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('changed Git-visible repository state');
    expect(isCallToolResponseResult(response) && response.verificationReceiptCandidate).toBeUndefined();
  });

  it.each([
    ['assume-unchanged', 'h src/app.ts\0'],
    ['skip-worktree', 'S src/app.ts\0'],
  ])('fails closed before verification when the index marks a tracked path $name', async (_name, taggedPaths) => {
    const command = 'custom-project-check';
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve({
        success: true,
        response: {
          exitCode: 0,
          result:
            params.command === GIT_TRACKED_PATH_TAGS_COMMAND
              ? taggedPaths
              : (BASE_GIT_STATE_RESULTS[params.command] ?? 'ok'),
        },
      }),
    );
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(JSON.stringify(response)).toContain('state before verification');
    expect(exec.mock.calls.some(call => call[0].command === command)).toBe(false);
  });

  it('does not replay verification after a provider disconnect leaves its outcome uncertain', async () => {
    const command = './scripts/validate.sh';
    let commandAttempts = 0;
    const createSandbox = jest.fn(() => Promise.resolve({ sandboxId: 'replacement' }));
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === command) {
        commandAttempts += 1;
        throw new SandboxNotAvailableError(params.sandboxId);
      }
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: BASE_GIT_STATE_RESULTS[params.command] ?? 'ok' },
      });
    });
    const sandbox = makeRepositorySandbox(makeProvider({ createSandbox, exec }), undefined, {
      existingSandboxId: 'v1:test:existing',
    });

    await expect(
      sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
        },
        { status: 'allow', scope: 'once' },
      ),
    ).rejects.toBeInstanceOf(SandboxNotAvailableError);

    expect(commandAttempts).toBe(1);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('ignores build artifacts excluded by Git', async () => {
    const command = 'make check';
    const exec = makeVerificationExec({
      verificationCommand: command,
      verificationResult: { success: true, response: { exitCode: 0, result: 'cache written and check passed' } },
      // Git omits ignored artifacts from --others --exclude-standard, so the
      // semantic before and after state remains identical.
      afterState: {},
    });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
    expect(exec.mock.calls.some(call => call[0].command === 'git ls-files --others --exclude-standard -z')).toBe(true);
  });

  it('keeps a durable receipt valid when another replica creates only ignored build artifacts', async () => {
    const executedCommands: string[] = [];
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      executedCommands.push(params.command);
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: BASE_GIT_STATE_RESULTS[params.command] ?? 'ok' },
      });
    });
    const coordinator = new TestDurableWorkspaceCoordinator();
    const verifier = makeRepositorySandbox(makeProvider({ exec }), coordinator);
    const builder = makeRepositorySandbox(makeProvider({ exec }), coordinator);
    const committer = makeRepositorySandbox(makeProvider({ exec }), coordinator);
    const approved = { status: 'allow', scope: 'once' } as const;

    const verified = await verifier.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify', purpose: 'verify', cwd: '/repo', command: 'pnpm test' },
      },
      approved,
    );
    await activateVerificationCandidate(verifier, verified);
    await builder.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Build', purpose: 'execute', cwd: '/repo', command: 'pnpm build' },
      },
      approved,
    );
    const committed = await committer.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Commit', purpose: 'commit', cwd: '/repo', command: 'git commit -m "verified"' },
      },
      approved,
    );

    expect(isCallToolResponseResult(committed) && committed.result.isError).toBe(false);
    expect(executedCommands).toContain('git commit -m "verified"');
  });

  it('invalidates a pre-mutation receipt when a structured edit crosses the workspace lease deadline', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-31T12:00:00.000Z') });
    try {
      let trackedChanged = false;
      const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
        if (params.command.includes('git apply --recount --unidiff-zero -- ') && !params.command.includes('--check')) {
          trackedChanged = true;
          // The provider mutated the checkout, then did not return until after
          // the original fixed 90-second workspace lease had expired.
          jest.setSystemTime(new Date(Date.now() + 91_000));
        }
        const result =
          params.command === TRACKED_WORKTREE_COMMAND && trackedChanged
            ? APP_CHANGED_LISTING
            : (BASE_GIT_STATE_RESULTS[params.command] ?? 'ok');
        return Promise.resolve({ success: true, response: { exitCode: 0, result } });
      });
      const coordinator = new TestDurableWorkspaceCoordinator();
      const provider = makeProvider({ exec, uploadFile: jest.fn().mockResolvedValue(undefined) });
      const verifier = makeRepositorySandbox(provider, coordinator);
      const editor = makeRepositorySandbox(provider, coordinator);
      const committer = makeRepositorySandbox(provider, coordinator);
      const approved = { status: 'allow', scope: 'once' } as const;

      await verifier.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Verify', purpose: 'verify', cwd: '/repo', command: 'pnpm test' },
        },
        approved,
      );
      const editCall = {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: {
          intent: 'Edit a tracked file',
          cwd: '/repo',
          patch: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
        },
      };
      const edited = await editor.callTool(
        editCall,
        approved,
        await structuredEditContext(editor, editCall, {
          admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
        }),
      );
      expect(isCallToolResponseResult(edited) && edited.result.isError).toBe(false);

      // Even if the checkout is later restored byte-for-byte, the old receipt
      // cannot become current again: the intervening mutation advanced epoch.
      trackedChanged = false;
      const committed = await committer.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Commit', purpose: 'commit', cwd: '/repo', command: 'git commit -m "stale"' },
        },
        approved,
      );
      expect(JSON.stringify(committed)).toContain('purpose verify');
      expect(exec.mock.calls.some(call => call[0].command === 'git commit -m "stale"')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps verification ownership through its declared timeout plus Git-state capture overhead', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-31T13:00:00.000Z') });
    try {
      let verificationRan = false;
      const command = 'pnpm test';
      const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
        if (params.command === command) {
          verificationRan = true;
          jest.setSystemTime(new Date(Date.now() + 59_000));
          return Promise.resolve({ success: true, response: { exitCode: 0, result: 'passed' } });
        }
        if (verificationRan && params.command.startsWith('git ')) {
          // Six semantic Git reads add 36 seconds after a command that used
          // almost all of its declared 60-second provider timeout.
          jest.setSystemTime(new Date(Date.now() + 6_000));
        }
        return Promise.resolve({
          success: true,
          response: { exitCode: 0, result: BASE_GIT_STATE_RESULTS[params.command] ?? 'ok' },
        });
      });
      const repository: BoundRepository = {
        ...boundRepository,
        commands: [{ command_id: 'verify', purpose: 'verify', command, timeout_ms: 60_000 }],
      };
      const sandbox = makeSandbox(makeProvider({ exec }), {
        boundRepository: repository,
        workspaceVerificationCoordinator: new TestDurableWorkspaceCoordinator(),
      });
      const response = await sandbox.callTool(
        {
          name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
          arguments: { intent: 'Verify near the timeout', command_id: 'verify' },
        },
        { status: 'allow', scope: 'once' },
      );

      expect(isCallToolResponseResult(response) && response.result.isError).toBe(false);
      expect(isCallToolResponseResult(response) && response.verificationReceiptCandidate).toBeDefined();
      expect(exec).toHaveBeenCalledWith(expect.objectContaining({ command, timeoutSeconds: 60 }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('invalidates a durable receipt when another replica changes tracked Git state', async () => {
    let trackedChanged = false;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'touch src/app.ts') trackedChanged = true;
      const result =
        params.command === TRACKED_WORKTREE_COMMAND && trackedChanged
          ? APP_CHANGED_LISTING
          : (BASE_GIT_STATE_RESULTS[params.command] ?? 'ok');
      return Promise.resolve({ success: true, response: { exitCode: 0, result } });
    });
    const coordinator = new TestDurableWorkspaceCoordinator();
    const verifier = makeRepositorySandbox(makeProvider({ exec }), coordinator);
    const editor = makeRepositorySandbox(makeProvider({ exec }), coordinator);
    const committer = makeRepositorySandbox(makeProvider({ exec }), coordinator);
    const approved = { status: 'allow', scope: 'once' } as const;

    await verifier.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify', purpose: 'verify', cwd: '/repo', command: 'pnpm test' },
      },
      approved,
    );
    await editor.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Edit', purpose: 'edit', cwd: '/repo', command: 'touch src/app.ts' },
      },
      approved,
    );
    const commit = await committer.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Commit', purpose: 'commit', cwd: '/repo', command: 'git commit -m "stale"' },
      },
      approved,
    );

    expect(isCallToolResponseResult(commit) && commit.result.isError).toBe(true);
    expect(JSON.stringify(commit)).toContain('purpose verify');
    expect(exec.mock.calls.some(call => call[0].command === 'git commit -m "stale"')).toBe(false);
  });

  it.each([
    ['nonzero exit', { success: true, response: { exitCode: 2, result: 'check failed' } } satisfies ExecResult],
    ['interrupted execution', { success: false, error: 'terminated by signal' } satisfies ExecResult],
    ['timeout outcome', { success: false, error: 'execution timed out' } satisfies ExecResult],
    ['unknown provider outcome', { success: false, error: 'execution outcome unknown' } satisfies ExecResult],
  ])('fails closed on $name', async (_name, verificationResult) => {
    const command = 'project-check';
    const exec = makeVerificationExec({ verificationCommand: command, verificationResult, afterState: {} });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(isCallToolResponseResult(response) && response.verificationReceiptCandidate).toBeUndefined();
  });

  it('fails closed when post-execution Git state cannot be captured', async () => {
    const command = 'project-check';
    const exec = makeVerificationExec({
      verificationCommand: command,
      verificationResult: { success: true, response: { exitCode: 0, result: 'check passed' } },
      afterState: { 'git rev-parse --show-toplevel': undefined },
    });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('could not be captured after execution');
  });

  it.each([
    ['rm tracked.ts', 'classified as edit'],
    ['env X=1 rm tracked.ts', 'classified as edit'],
    ['X=1 rm tracked.ts', 'classified as edit'],
    ['git commit -m bad', 'classified as commit'],
    ['git push origin HEAD', 'classified as push'],
  ])('blocks destructive verification before execution: %s', async (command, expectedError) => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'Verify the repository', purpose: 'verify', cwd: '/repo', command },
    });

    expect(JSON.stringify(response)).toContain(expectedError);
    expect(exec).not.toHaveBeenCalled();
  });

  it('carries one verification receipt into a same-session reconstructed sandbox', async () => {
    const executedCommands: string[] = [];
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      executedCommands.push(params.command);
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: BASE_GIT_STATE_RESULTS[params.command] ?? 'ok' },
      });
    });
    const provider = makeProvider({ exec });
    const coordinator = new TestDurableWorkspaceCoordinator();
    const sandbox = makeRepositorySandbox(provider, coordinator);
    const approved = { status: 'allow', scope: 'once' } as const;
    const call = (purpose: 'edit' | 'verify' | 'commit', command: string) =>
      sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Complete the coding task', purpose, cwd: '/repo', command },
        },
        approved,
      );

    const missing = await call('commit', 'git commit -m "fix"');
    expect(JSON.stringify(missing)).toContain('purpose verify');
    expect(executedCommands).not.toContain('git commit -m "fix"');

    const verified = await call('verify', 'pnpm test');
    if (!isCallToolResponseResult(verified)) throw new Error('Expected a tool result');
    const verifiedContent = verified.result.content[0];
    if (verifiedContent?.type !== 'text') throw new Error('Expected a text tool result');
    expect(JSON.parse(verifiedContent.text)).toMatchObject({ verification: { passed: true } });
    await activateVerificationCandidate(sandbox, verified);
    // A second replica can consume the receipt without any process-local activation.
    const reconstructed = makeRepositorySandbox(provider, coordinator);
    const committed = await reconstructed.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Commit the verified change',
          purpose: 'commit',
          cwd: '/repo',
          command: 'git commit -m "fix"',
        },
      },
      approved,
    );
    expect(isCallToolResponseResult(committed) && committed.result.isError).toBe(false);
    expect(executedCommands).toContain('git commit -m "fix"');

    const reused = await reconstructed.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Reuse the same receipt',
          purpose: 'commit',
          cwd: '/repo',
          command: 'git commit -m "second"',
        },
      },
      approved,
    );
    expect(JSON.stringify(reused)).toContain('purpose verify');
    expect(executedCommands).not.toContain('git commit -m "second"');
  });

  it('keeps every ordinary and structured workspace operation provider-locked after barrier exit 125', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve(
        params.command.startsWith('mkdir -p ') || params.command.startsWith('rm -f ')
          ? { success: true, response: { exitCode: 0, result: 'initialized' } }
          : { success: true, response: { exitCode: 125, result: 'workspace termination pending' } },
      ),
    );
    const provider = makeProvider({ exec });
    const sandbox = makeSandbox(provider, { boundRepository });
    const approved: { status: 'allow'; scope: 'once' } = { status: 'allow', scope: 'once' };
    const calls: ReadonlyArray<{ purpose: SandboxInvocationPurpose; command: string }> = [
      { purpose: 'inspect', command: 'git status' },
      { purpose: 'push', command: 'git push origin HEAD' },
      { purpose: 'edit', command: 'touch src/blocked.ts' },
      { purpose: 'execute', command: 'node scripts/task.mjs' },
      { purpose: 'verify', command: 'pnpm test' },
      { purpose: 'commit', command: 'git commit -m blocked' },
    ];

    for (const call of calls) {
      await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Exercise termination fencing', cwd: '/repo', ...call },
        },
        approved,
      );
    }
    await sandbox.callTool(
      {
        name: SANDBOX_APPLY_PATCH_TOOL_NAME,
        arguments: {
          intent: 'Apply a fenced patch',
          cwd: '/repo',
          patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
        },
      },
      approved,
    );
    await sandbox.callTool(
      {
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          intent: 'Apply a fenced structured edit',
          cwd: '/repo',
          path: 'src/app.ts',
          old_text: 'old',
          new_text: 'new',
          replace_all: false,
        },
      },
      approved,
    );

    expect(exec).toHaveBeenCalled();
    const workspaceCalls = exec.mock.calls.map(([params]) => params).filter(params => params.cwd === '/repo');
    expect(workspaceCalls).not.toHaveLength(0);
    expect(workspaceCalls.every(params => params.workspaceLock?.workspaceRoot === '/repo')).toBe(true);
  });

  it('reports a completed command with a nonzero exit code as a tool error', async () => {
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> =>
      Promise.resolve(
        params.command === 'pnpm test'
          ? { success: true, response: { exitCode: 1, result: 'tests failed' } }
          : { success: true, response: { exitCode: 0, result: BASE_GIT_STATE_RESULTS[params.command] ?? 'ok' } },
      ),
    );
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Verify the change', purpose: 'verify', cwd: '/repo', command: 'pnpm test' },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('did not complete successfully with exit code 0');
  });

  it('consumes verification before a failed commit can mutate the workspace', async () => {
    let commitAttempts = 0;
    const exec = jest.fn((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.command === 'git commit -m "fix"') {
        commitAttempts += 1;
        return Promise.resolve({
          success: true,
          response: { exitCode: commitAttempts === 1 ? 1 : 0, result: 'commit hook failed after editing files' },
        });
      }
      return Promise.resolve({
        success: true,
        response: { exitCode: 0, result: BASE_GIT_STATE_RESULTS[params.command] ?? 'ok' },
      });
    });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const approved = { status: 'allow', scope: 'once' } as const;
    const call = (purpose: 'verify' | 'commit', command: string) =>
      sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'Complete the coding task', purpose, cwd: '/repo', command },
        },
        approved,
      );

    const verified = await call('verify', 'pnpm test');
    await activateVerificationCandidate(sandbox, verified);
    const failedCommit = await call('commit', 'git commit -m "fix"');
    // A bare `git commit` with a non-zero exit is not in the search/diff table, so it reports
    // "exited" (never guessed at as ok or a genuine "failed") - isError stays false, and the exit
    // code/output are what say the commit did not go through.
    if (!isCallToolResponseResult(failedCommit)) {
      throw new Error('expected tool result');
    }
    expect(failedCommit.result.isError).toBe(false);
    const failedCommitContent = failedCommit.result.content[0];
    if (!failedCommitContent || failedCommitContent.type !== 'text') {
      throw new Error('expected text content');
    }
    const failedCommitResponse = JSON.parse(failedCommitContent.text);
    expect(failedCommitResponse.status).toBe('exited');
    expect(failedCommitResponse.exit_code).toBe(1);

    const retry = await call('commit', 'git commit -m "fix"');
    expect(JSON.stringify(retry)).toContain('purpose verify');
    expect(commitAttempts).toBe(1);
  });

  it('refuses a combined commit and push command', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Commit and push',
        purpose: 'commit',
        command: 'git commit -m fix && git push',
        cwd: '/repo',
      },
    });
    expect(JSON.stringify(response)).toContain('separate commands');
    expect(exec).not.toHaveBeenCalled();
  });

  it('executes arbitrary verification pipelines and judges their observed exit status', async () => {
    const command = './scripts/validate.sh 2>&1 | head -20';
    const exec = makeVerificationExec({
      verificationCommand: command,
      verificationResult: { success: true, response: { exitCode: 7, result: 'validation failed\n' } },
      afterState: {},
    });
    const sandbox = makeRepositorySandbox(makeProvider({ exec }));
    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Typecheck',
          purpose: 'verify',
          command,
          cwd: '/repo',
        },
      },
      { status: 'allow', scope: 'once' },
    );

    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    if (!isCallToolResponseResult(response)) throw new Error('Expected a tool result');
    const content = response.result.content[0];
    if (content?.type !== 'text') throw new Error('Expected text tool output');
    expect(JSON.parse(content.text)).toMatchObject({
      verification: { execution_succeeded: false, passed: false, repository_unchanged: true },
    });
    expect(exec.mock.calls.filter(call => call[0].command === command)).toHaveLength(1);
  });

  it('rejects evaluator wrappers before approval but permits quoted pipe data', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    const wrapped = {
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Commit and push',
        purpose: 'commit',
        command: "sh -c 'git commit -m fix && git push'",
        cwd: '/repo',
      },
    };

    await expect(sandbox.toolCallInfo(wrapped)).resolves.toEqual(
      expect.objectContaining({ is_approval_required: false }),
    );
    const response = await sandbox.callTool(wrapped);
    expect(JSON.stringify(response)).toContain('command-evaluator wrappers');
    expect(exec).not.toHaveBeenCalled();

    await expect(
      sandbox.toolCallInfo({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Run filtered tests',
          purpose: 'verify',
          command: "pnpm test --filter 'foo|bar'",
          cwd: '/repo',
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ is_approval_required: true }));
  });

  it('does not execute a denied command or expose its output', async () => {
    const exec = jest.fn((): Promise<ExecResult> =>
      Promise.resolve({ success: true, response: { exitCode: 0, result: 'real output' } }),
    );
    const sandbox = makeSandbox(makeProvider({ exec }));

    const response = await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Run command', purpose: 'execute', command: 'printf real-output' },
      },
      { status: 'deny', reason: 'not approved' },
    );

    expect(exec).not.toHaveBeenCalled();
    expect(isCallToolResponseResult(response)).toBe(true);
    if (isCallToolResponseResult(response)) {
      expect(response.result.isError).toBe(true);
      expect(response.result.content).toEqual([
        { type: 'text', text: JSON.stringify({ error: 'User denied tool call: not approved' }) },
      ]);
    }
  });

  it('rejects HOME as a substitute for the command working directory', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Inspect the repository',
        purpose: 'inspect',
        command: 'git status --short',
        env: { HOME: '/tmp/repository' },
      },
    });

    expect(JSON.stringify(response)).toContain('Pass the checked-out repository path in cwd');
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects verify-purpose commands with unsafe shell syntax before approval', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    for (const command of ['pnpm test > /tmp/test.log', 'echo $(pnpm test)', 'pnpm test &']) {
      const wrapped = {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Run tests', purpose: 'verify', command, cwd: '/repo' },
      };
      await expect(sandbox.toolCallInfo(wrapped)).resolves.toEqual(
        expect.objectContaining({ is_approval_required: false }),
      );
      const response = await sandbox.callTool(wrapped);
      expect(JSON.stringify(response)).toContain('Verification commands must not use shell redirection');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects verify-purpose inline evaluation before approval', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    for (const command of ["python -c 'import sys; sys.exit(0)'", "node -e 'process.exit(0)'"]) {
      const wrapped = {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Run tests', purpose: 'verify', command, cwd: '/repo' },
      };
      await expect(sandbox.toolCallInfo(wrapped)).resolves.toEqual(
        expect.objectContaining({ is_approval_required: false }),
      );
      const response = await sandbox.callTool(wrapped);
      // The interpreter guard fires before the old verify-purpose screening and
      // redirects to run_code — still rejected before approval and dispatch.
      expect(JSON.stringify(response)).toContain('use the run_code tool instead');
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('still permits observable verify-purpose commands', async () => {
    const exec = jest.fn(() => readyExec());
    const sandbox = makeSandbox(makeProvider({ exec }));
    await expect(
      sandbox.toolCallInfo({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: {
          intent: 'Run tests',
          purpose: 'verify',
          command: 'pnpm test 2>&1 | tail -20',
          cwd: '/repo',
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ is_approval_required: true }));
    expect(exec).not.toHaveBeenCalled();
  });

  it('uploads user files to the provider uploads dir', async () => {
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const provider = makeProvider({ uploadFile });
    const sandbox = makeSandbox(provider);
    const stored = await sandbox.uploadUserFile({
      fileName: 'notes.txt',
      content: Buffer.from('hi'),
      mime: 'text/plain',
    });
    expect(stored.filePath).toBe('/prov/uploads/notes.txt');
    expect(uploadFile).toHaveBeenCalledWith({
      sandboxId: 'raw-1',
      remotePath: '/prov/uploads/notes.txt',
      content: Buffer.from('hi'),
    });
  });

  it('preserves a newly created sandbox identity when its first user-file upload fails', async () => {
    const provider = makeProvider({ uploadFile: jest.fn().mockRejectedValue(new Error('upload unavailable')) });
    const sandbox = makeSandbox(provider);

    const upload = sandbox.uploadUserFile({
      fileName: 'notes.txt',
      content: Buffer.from('hi'),
      mime: 'text/plain',
    });

    await expect(upload).rejects.toBeInstanceOf(SandboxFileUploadError);
    await expect(upload).rejects.toMatchObject({
      sandboxCreated: { sandbox_id: 'v1:test:raw-1' },
      cause: expect.objectContaining({ message: 'upload unavailable' }),
    });
  });

  it('uploads skill-init files from the mounter before the skill init exec', async () => {
    const events: string[] = [];
    const uploadFile = jest.fn().mockImplementation(async (args: { remotePath: string }) => {
      if (args.remotePath === `/prov/skills/${REQUESTED_SKILLS_FILE_NAME}`) {
        events.push('skill-upload');
      }
    });
    const exec = jest.fn().mockImplementation((params: SandboxExecParams): Promise<ExecResult> => {
      if (params.env?.['TFY_SKILLS_DIR'] === '/prov/skills') {
        events.push('skill-init-exec');
      }
      return readyExec();
    });
    const gitSkill = {
      type: 'git',
      name: 'echo',
      description: 'Echo',
      url: 'https://github.com/acme/skills.git',
      path: '',
      ref: 'a'.repeat(40),
    } satisfies GitSkill;
    const sandbox = makeSandbox(makeProvider({ uploadFile, exec }), {
      skillMounter: new SkillMounter({ skills: [gitSkill] }),
    });

    await sandbox.uploadUserFile({
      fileName: 'notes.txt',
      content: Buffer.from('hi'),
      mime: 'text/plain',
    });

    const skillsUpload = uploadFile.mock.calls
      .map((call: unknown[]) => call[0] as { remotePath: string; content: Buffer; sandboxId: string })
      .find(args => args.remotePath === `/prov/skills/${REQUESTED_SKILLS_FILE_NAME}`);
    expect(skillsUpload).toBeDefined();
    if (skillsUpload === undefined) {
      return;
    }
    expect(skillsUpload).toEqual({
      sandboxId: 'raw-1',
      remotePath: `/prov/skills/${REQUESTED_SKILLS_FILE_NAME}`,
      content: expect.any(Buffer),
    });
    expect(JSON.parse(skillsUpload.content.toString('utf-8'))).toEqual({
      skills: [
        {
          type: 'git',
          name: 'echo',
          url: gitSkill.url,
          path: '',
          ref: gitSkill.ref,
        },
      ],
    });
    expect(events.indexOf('skill-upload')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('skill-init-exec')).toBeGreaterThan(events.indexOf('skill-upload'));
    expect(
      exec.mock.calls.some((call: unknown[]) => {
        const params = call[0] as SandboxExecParams;
        return (
          params.env?.['TFY_SKILLS_DIR'] === '/prov/skills' &&
          params.timeoutSeconds === 180 &&
          typeof params.command === 'string' &&
          params.command.includes('/prov/skill_downloader.py')
        );
      }),
    ).toBe(true);
  });

  it('does not rewrite a caller PATH (providers own PATH)', async () => {
    const execCalls: SandboxExecParams[] = [];
    const uploadFile = jest.fn().mockResolvedValue(undefined);
    const transport: CodeModeTransport = {
      getClientInstall: () => ({
        content: 'print("mock")\n',
        remotePath: 'mcp-client/mcp_client.py',
      }),
      start: () =>
        Promise.resolve({
          env: { TFY_NATS_URL: 'ws://localhost:4223', TFY_NATS_SUBJECT_PREFIX: 'sandbox.bridge.test' },
        }),
      stop: () => Promise.resolve(),
    };
    const sandbox = makeSandbox(
      makeProvider({
        exec: (params): Promise<ExecResult> => {
          execCalls.push(params);
          return readyExec();
        },
        uploadFile,
        createCodeModeTransport: () => transport,
      }),
    );
    sandbox.configureCodeMode([makeMockIMCPServer({ name: 'github', preload: true })]);
    await sandbox.callTool(
      {
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'Run command', purpose: 'execute', command: 'true', env: { PATH: '/usr/bin' } },
      },
      { status: 'allow', scope: 'once' },
    );
    const call = execCalls.find(item => item.command === 'true');
    expect(call?.env?.['PATH']).toBe('/usr/bin');
    expect(call?.env?.['PYTHONPATH']).toBe('mcp-client');
    const init = execCalls.find(item => item.command.includes('ln -sf'));
    const portableCommand = init?.command.replaceAll('\\', '/');
    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({ remotePath: 'mcp-client/mcp_client.py.new' }));
    expect(portableCommand).toContain("mv -f 'mcp-client/mcp_client.py.new' 'mcp-client/mcp_client.py'");
    expect(portableCommand).toContain("ln -sf '../mcp_client.py'");
    expect(portableCommand).toContain('mcp-client/bin/mcp-client');
  });
});

/** Runs a guest command for real, in `cwd`, with only the env the test allows. */
function runGuestCommand(input: { command: string; cwd: string; env: Record<string, string> }): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(
      '/bin/sh',
      ['-c', input.command],
      { cwd: input.cwd, env: { PATH: '/usr/bin:/bin', ...input.env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ success: true, response: { exitCode, result: `${stdout}${stderr}` } });
      },
    );
  });
}

/**
 * A slot-like provider: its commands and files are real, under `root`. Like the slot agent, it refuses
 * every env name except TFY_SKILLS_DIR at the skills directory.
 */
function slotLikeProvider(input: { root: string; skillsDir: string; execCalls: SandboxExecParams[] }): SandboxProvider {
  const { root, skillsDir, execCalls } = input;
  return makeProvider({
    network: 'none',
    exec: (params): Promise<ExecResult> => {
      execCalls.push(params);
      const env = params.env ?? {};
      const refused = Object.keys(env).filter(name => name !== 'TFY_SKILLS_DIR' || env[name] !== skillsDir);
      if (refused.length > 0) {
        return Promise.resolve({ success: false, error: `env names are not allowed: ${refused.join(', ')}` });
      }
      return runGuestCommand({ command: params.command, cwd: root, env });
    },
    getToolResultDumpDir: () => join(root, 'tool-results'),
    getFileUploadsDir: () => join(root, 'uploads'),
    getGitCredentialsPath: () => join(root, '.git-credentials'),
    getSkillsDir: () => skillsDir,
    getSkillDownloaderPath: () => join(root, 'skill_downloader.py'),
    uploadFile: async ({ remotePath, content }) => {
      await mkdir(dirname(remotePath), { recursive: true });
      await writeFile(remotePath, content);
    },
  });
}

/** A registry skill tarball holding one SKILL.md, built with the host's tar. */
function skillArchive(input: { root: string; name: string }): Buffer {
  const { root, name } = input;
  const source = mkdtempSync(join(root, `${name}-src-`));
  writeFileSync(join(source, 'SKILL.md'), `# ${name}\n`);
  const archive = join(root, `${name}.tar`);
  execFileSync('/usr/bin/tar', ['-cf', archive, '-C', source, '.']);
  return readFileSync(archive);
}

async function serveArchives(
  archives: ReadonlyMap<string, Buffer>,
): Promise<{ urlFor: (path: string) => string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const bytes = archives.get(request.url ?? '');
    if (bytes === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/x-tar' }).end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    urlFor: path => `http://127.0.0.1:${String(port)}${path}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function registrySkill(input: { name: string; presignedUrl: string }): Skill {
  const { name, presignedUrl } = input;
  return {
    type: 'registry',
    name,
    description: name,
    fqn: `agent-skill:acme/team/${name}:1`,
    preload: false,
    skillMdContent: null,
    presignedUrl,
  };
}

describe('Sandbox skills without a network', () => {
  const gitSkill = {
    type: 'git',
    name: 'echo',
    description: 'Echo',
    url: 'https://github.com/acme/skills.git',
    path: '',
    ref: 'a'.repeat(40),
  } satisfies GitSkill;

  const execTrue = {
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: { intent: 'Run command', purpose: 'execute', command: 'true' },
  };

  it('copies the skills into a no-network sandbox and the downloader confirms them offline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-skills-'));
    const archives = await serveArchives(
      new Map([
        ['/alpha.tar', skillArchive({ root, name: 'alpha' })],
        ['/beta.tar', skillArchive({ root, name: 'beta' })],
      ]),
    );
    try {
      const skillsDir = join(root, 'skills');
      const execCalls: SandboxExecParams[] = [];
      const provider = slotLikeProvider({ root, skillsDir, execCalls });
      const alpha = registrySkill({ name: 'alpha', presignedUrl: archives.urlFor('/alpha.tar') });
      const beta = registrySkill({ name: 'beta', presignedUrl: archives.urlFor('/beta.tar') });
      const sandbox = makeSandbox(provider, { skillMounter: new SkillMounter({ skills: [alpha, beta] }) });

      const response = await sandbox.callTool(execTrue, { status: 'allow', scope: 'once' });

      expect(isCallToolResponseResult(response) && response.result.isError).toBeFalsy();
      expect(readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('# alpha\n');
      expect(readFileSync(join(skillsDir, 'beta', 'SKILL.md'), 'utf-8')).toBe('# beta\n');
      const skillInit = execCalls.filter(call => call.env?.['TFY_SKILLS_DIR'] !== undefined);
      expect(skillInit).toHaveLength(1);
      expect(skillInit[0]?.env).toEqual({ TFY_SKILLS_DIR: skillsDir });
      expect(execCalls.some(call => call.command === 'true')).toBe(true);
      const builder = new InstructionBuilder('prompt');
      sandbox.buildInstruction(builder);
      expect(builder.build()).not.toContain('unavailable');
    } finally {
      await archives.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves out a skill that cannot be downloaded, names it as unavailable, and still copies the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-skills-'));
    const archives = await serveArchives(new Map([['/alpha.tar', skillArchive({ root, name: 'alpha' })]]));
    try {
      const skillsDir = join(root, 'skills');
      const provider = slotLikeProvider({ root, skillsDir, execCalls: [] });
      const broken = registrySkill({ name: 'gamma', presignedUrl: archives.urlFor('/missing.tar') });
      const sandbox = makeSandbox(provider, {
        skillMounter: new SkillMounter({
          skills: [registrySkill({ name: 'alpha', presignedUrl: archives.urlFor('/alpha.tar') }), broken],
        }),
      });

      const response = await sandbox.callTool(execTrue, { status: 'allow', scope: 'once' });

      expect(isCallToolResponseResult(response) && response.result.isError).toBeFalsy();
      expect(readFileSync(join(skillsDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('# alpha\n');
      const builder = new InstructionBuilder('prompt');
      sandbox.buildInstruction(builder);
      const prompt = builder.build();
      expect(prompt).toContain("gamma: unavailable (couldn't be copied into the sandbox)");
      expect(prompt).not.toContain('alpha: unavailable');
      if (!isCallToolResponseResult(response) || response.result.content[0]?.type !== 'text') {
        throw new Error('Expected a text result');
      }
      expect(JSON.parse(response.result.content[0].text)).toMatchObject({
        notices: [
          "The skill gamma couldn't be loaded, so Aman is working without it. Check your internet connection, then start a new chat.",
        ],
      });
    } finally {
      await archives.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts a no-network sandbox for an assistant with no skills and sends no skill env', async () => {
    const execCalls: SandboxExecParams[] = [];
    // Sessions always build a mounter, even with no skills; its init must not reach a no-network sandbox.
    const provider = makeProvider({
      network: 'none',
      exec: (params): Promise<ExecResult> => {
        execCalls.push(params);
        const envNames = Object.keys(params.env ?? {});
        if (envNames.length > 0) {
          return Promise.resolve({ success: false, error: `env names are not allowed: ${envNames.join(', ')}` });
        }
        return readyExec();
      },
    });
    const sandbox = makeSandbox(provider, { skillMounter: new SkillMounter({ skills: [] }) });

    const response = await sandbox.callTool(execTrue, { status: 'allow', scope: 'once' });

    expect(isCallToolResponseResult(response) && response.result.isError).toBeFalsy();
    expect(execCalls.some(call => call.command === 'true')).toBe(true);
    expect(execCalls.some(call => call.env?.['TFY_SKILLS_DIR'] !== undefined)).toBe(false);
    expect(execCalls.some(call => call.command.includes('skill_downloader.py'))).toBe(false);
  });

  it('shows the person a plain sentence when the sandbox will not start, not the provider error', async () => {
    const provider = makeProvider({
      exec: (params): Promise<ExecResult> =>
        params.env?.['TFY_SKILLS_DIR'] === undefined
          ? readyExec()
          : Promise.resolve({ success: false, error: 'env names are not allowed: TFY_SKILLS_DIR' }),
    });
    const sandbox = makeSandbox(provider, { skillMounter: new SkillMounter({ skills: [gitSkill] }) });

    const response = await sandbox.callTool(execTrue, { status: 'allow', scope: 'once' });

    if (!isCallToolResponseResult(response) || response.result.content[0]?.type !== 'text') {
      expect(response).toBe('a text refusal');
      return;
    }
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({ error: SANDBOX_START_FAILED_MESSAGE });
    expect(response.result.content[0].text).not.toContain('env names');
  });
});

describe('Sandbox host bookkeeping', () => {
  it('runs every host-authored command on the trusted PATH and only the model command on the sandbox PATH', async () => {
    const commands: string[] = [];
    const transport: CodeModeTransport = {
      getClientInstall: () => ({ content: 'print("mock")\n', remotePath: 'mcp-client/mcp_client.py' }),
      start: () =>
        Promise.resolve({
          env: { TFY_NATS_URL: 'ws://localhost:4223', TFY_NATS_SUBJECT_PREFIX: 'sandbox.bridge.test' },
        }),
      stop: () => Promise.resolve(),
    };
    const provider: SandboxProvider = {
      ...makeProvider({ createCodeModeTransport: () => transport }),
      exec: (params): Promise<ExecResult> => {
        commands.push(params.command);
        return readyExec();
      },
    };
    const sandbox = makeSandbox(provider, { skillMounter: new SkillMounter([]) });
    sandbox.configureCodeMode([makeMockIMCPServer({ name: 'github', preload: true })]);
    await sandbox.callTool(
      { name: SANDBOX_EXEC_TOOL_NAME, arguments: { intent: 'Run command', purpose: 'execute', command: 'true' } },
      { status: 'allow', scope: 'once' },
    );
    const trustedPrefix = withTrustedPath('');
    expect(commands).toContain('true');
    expect(commands.some(command => command.includes('skill_downloader.py'))).toBe(true);
    expect(commands.some(command => command.includes('mcp_client.py'))).toBe(true);
    expect(commands.filter(command => command !== 'true' && !command.startsWith(trustedPrefix))).toEqual([]);
  });

  it('runs setup scripts in isolated mode so the workspace stays off the import path', () => {
    expect(buildWriteAndRunScriptCommand({ scriptPath: 'skill_downloader.py', scriptContent: 'pass\n' })).toMatch(
      / && python3 -I -S 'skill_downloader\.py'$/u,
    );
  });
});
