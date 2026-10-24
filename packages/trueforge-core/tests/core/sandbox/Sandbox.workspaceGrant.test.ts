/**
 * Sandbox commands in a "Work on a repo" chat, through the tool route a chat classifies them on: reads never ask, one
 * "Always allow this here" covers the later commands in that workspace, and a push or anything reaching out still asks.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { allowsChatApproval, chatGrantKey, effectiveToolAdmissions } from '../../../src/core/mcp/approvalGrant';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

let workspace: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-grant-')));
  mkdirSync(join(workspace, 'exitramp', 'src'), { recursive: true });
  writeFileSync(join(workspace, 'exitramp', 'README.md'), 'Exit ramp\n');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeSandbox(execCalls: SandboxExecParams[] = []): Sandbox {
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: (params): Promise<ExecResult> => {
      execCalls.push(params);
      return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
    },
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async (params): Promise<never> => {
      throw new Error(`unexpected commit ${params.command}`);
    },
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => workspace,
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
  return new Sandbox({
    provider,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: workspace,
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    }),
  });
}

function exec(sandbox: Sandbox, input: { purpose: string; command: string }): Promise<InternalToolCallInfo> {
  return sandbox.toolCallInfo({
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: { intent: 'Work on the repo', purpose: input.purpose, command: input.command, cwd: workspace },
  });
}

function call(id: string, info: InternalToolCallInfo): InternalEnrichedToolCall {
  return { id, type: 'function', function: { name: SANDBOX_EXEC_TOOL_NAME, arguments: '{}' }, tool_info: info };
}

/** Whether a call shows a card once the chat holds these "Always allow this here" answers. */
function showsCard(info: InternalToolCallInfo, grants: ReadonlySet<string>): boolean {
  const admitted = effectiveToolAdmissions({
    calls: [call('c', info)],
    decisions: new Map(),
    chatApprovalGrants: grants,
    implementationPlanGrants: new Set(),
  });
  return info.is_approval_required === true && admitted.get('c')?.decision === undefined;
}

describe('reads in the workspace never ask', () => {
  it('runs a read-only list with no card and no grant', async () => {
    const sandbox = makeSandbox();
    for (const command of [
      `cd ${workspace}/exitramp && sed -n '55,172p' README.md`,
      'cd exitramp && git status && git log --oneline',
      'cd exitramp && grep -rn TODO src | head -20',
    ]) {
      const info = await exec(sandbox, { purpose: 'inspect', command });
      expect({ command, tier: info.tier, card: showsCard(info, new Set()) }).toEqual({ command, tier: 1, card: false });
    }
  });

  it('still asks for a list that leaves the workspace', async () => {
    const info = await exec(makeSandbox(), { purpose: 'inspect', command: 'cd /etc && cat hostname' });
    expect(showsCard(info, new Set())).toBe(true);
  });

  it('runs the list as the pinned programs, never by name on the sandbox PATH', async () => {
    const execCalls: SandboxExecParams[] = [];
    const sandbox = makeSandbox(execCalls);
    const result = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: {
        intent: 'Read the readme',
        purpose: 'inspect',
        command: "cd exitramp && sed -n '1,5p' README.md",
        cwd: workspace,
      },
    });
    expect(isCallToolResponseResult(result)).toBe(true);
    const ran = execCalls.map(params => params.command).find(command => command.includes('README.md'));
    expect(ran).toMatch(
      /^cd 'exitramp' && '[^']*env' 'PATH=\/usr\/bin:\/bin' '\/[^']*\/sed' '-n' '1,5p' 'README.md'$/u,
    );
  });
});

describe('"Always allow this here" on a sandbox command', () => {
  it('covers the next three different commands in that workspace with no card', async () => {
    const sandbox = makeSandbox();
    const first = await exec(sandbox, { purpose: 'execute', command: 'pnpm test' });
    expect(first.is_approval_required).toBe(true);
    expect(allowsChatApproval(first)).toBe(true);
    const grants = new Set([chatGrantKey(first)]);

    for (const next of [
      { purpose: 'execute', command: 'pnpm lint' },
      { purpose: 'edit', command: "sed -i 's/Exit/Off/' exitramp/README.md" },
      { purpose: 'inspect', command: 'cd exitramp && wc -l README.md' },
    ]) {
      const info = await exec(sandbox, next);
      expect(info.is_approval_required).toBe(true);
      expect({ command: next.command, card: showsCard(info, grants) }).toEqual({ command: next.command, card: false });
    }
  });

  it('never covers a push, a clone, a network tool or a download, and never offers itself on one', async () => {
    const sandbox = makeSandbox();
    const grants = new Set([chatGrantKey(await exec(sandbox, { purpose: 'execute', command: 'pnpm test' }))]);
    for (const next of [
      { purpose: 'push', command: 'git push origin main' },
      { purpose: 'edit', command: 'git clone https://github.com/example/tool.git tool' },
      { purpose: 'execute', command: 'curl https://example.com/data.json' },
      { purpose: 'execute', command: 'cd exitramp && npx prettier --check .' },
    ]) {
      const info = await exec(sandbox, next);
      expect({
        command: next.command,
        card: showsCard(info, grants),
        workspace: info.sandbox_workspace_grant,
      }).toEqual({ command: next.command, card: true, workspace: undefined });
    }
  });

  it('never covers a command that reads a key file', async () => {
    const sandbox = makeSandbox();
    const grants = new Set([chatGrantKey(await exec(sandbox, { purpose: 'execute', command: 'pnpm test' }))]);
    const info = await exec(sandbox, { purpose: 'inspect', command: 'cat .env | wc -l' });
    expect(info.sandbox_workspace_grant).toBeUndefined();
    expect(showsCard(info, grants)).toBe(true);
  });

  it('does not reach a different workspace', async () => {
    const first = await exec(makeSandbox(), { purpose: 'execute', command: 'pnpm test' });
    const grants = new Set([chatGrantKey(first)]);
    const elsewhere = workspace;
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-grant-other-')));
    try {
      const info = await exec(makeSandbox(), { purpose: 'execute', command: 'pnpm lint' });
      expect(showsCard(info, grants)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      workspace = elsewhere;
    }
  });
});
