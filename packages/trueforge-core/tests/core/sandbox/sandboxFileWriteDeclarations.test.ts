/**
 * The sandbox file-write set is computed from the tools' own declarations.
 *
 * A tool that appears in no list anywhere is covered the moment its declaration
 * says it writes files, and today's file-write tools stay covered because their
 * declarations say so.
 */
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import {
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_FILE_WRITE_TOOLS,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
  SANDBOX_TOOL_DECLARATIONS,
  SANDBOX_WRITE_FILE_TOOL_NAME,
  Sandbox,
  sandboxFileWriteToolNames,
  type SandboxToolDeclaration,
} from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function makeProvider(): SandboxProvider {
  return {
    type: 'test',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: 'raw-1' }),
    exec: (): Promise<ExecResult> => Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: async (params): Promise<never> => {
      throw new Error(`unexpected commit ${params.command}`);
    },
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => '/work',
    getToolResultDumpDir: () => '/prov/tool-results',
    getGitCredentialsPath: () => '/prov/.git-credentials',
    getFileUploadsDir: () => '/prov/uploads',
    getSkillsDir: () => '/prov/skills',
    getSkillDownloaderPath: () => '/prov/git_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(): Sandbox {
  return new Sandbox({
    provider: makeProvider(),
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: '/work',
      services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    }),
  });
}

describe('sandbox file-write declarations', () => {
  test('the set is computed from the declarations, so an invented tool is covered by declaring', () => {
    const declarations: readonly SandboxToolDeclaration[] = [
      { name: 'invented_file_writer', writesFiles: true },
      { name: 'invented_reader', writesFiles: false },
    ];
    expect(sandboxFileWriteToolNames(declarations)).toEqual(new Set(['invented_file_writer']));
  });

  test("today's file-write tools are the computed set, from their own declarations", () => {
    expect(SANDBOX_FILE_WRITE_TOOLS).toEqual(
      new Set([SANDBOX_WRITE_FILE_TOOL_NAME, SANDBOX_APPLY_PATCH_TOOL_NAME, SANDBOX_REPLACE_TEXT_TOOL_NAME]),
    );
  });

  test('every registered sandbox tool is declared exactly once', () => {
    const names = SANDBOX_TOOL_DECLARATIONS.map(declaration => declaration.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(
      new Set([
        SANDBOX_EXEC_TOOL_NAME,
        SANDBOX_RUN_CODE_TOOL_NAME,
        SANDBOX_APPLY_PATCH_TOOL_NAME,
        SANDBOX_REPLACE_TEXT_TOOL_NAME,
        SANDBOX_WRITE_FILE_TOOL_NAME,
        SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
        SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
      ]),
    );
  });

  test('the sandbox answers isFileWriteTool from the declarations', async () => {
    const sandbox = makeSandbox();
    expect(sandbox.isFileWriteTool(SANDBOX_WRITE_FILE_TOOL_NAME)).toBe(true);
    expect(sandbox.isFileWriteTool(SANDBOX_APPLY_PATCH_TOOL_NAME)).toBe(true);
    expect(sandbox.isFileWriteTool(SANDBOX_REPLACE_TEXT_TOOL_NAME)).toBe(true);
    expect(sandbox.isFileWriteTool(SANDBOX_EXEC_TOOL_NAME)).toBe(false);
    expect(sandbox.isFileWriteTool(SANDBOX_RUN_CODE_TOOL_NAME)).toBe(false);
    expect(sandbox.isFileWriteTool('invented_file_writer')).toBe(false);

    const listed = await sandbox.listTools();
    const listedNames = listed.result.tools.map(tool => tool.name);
    for (const name of listedNames) {
      expect(SANDBOX_TOOL_DECLARATIONS.some(declaration => declaration.name === name)).toBe(true);
    }
    expect(listedNames).toEqual(
      expect.arrayContaining([
        SANDBOX_WRITE_FILE_TOOL_NAME,
        SANDBOX_APPLY_PATCH_TOOL_NAME,
        SANDBOX_REPLACE_TEXT_TOOL_NAME,
      ]),
    );
  });
});
