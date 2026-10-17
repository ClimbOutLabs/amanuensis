import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, SANDBOX_REPLACE_TEXT_TOOL_NAME, Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function readyExec(): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
}

function makeProvider(
  overrides: Partial<SandboxProvider> & Pick<SandboxProvider, 'createSandbox' | 'exec'>,
): SandboxProvider {
  return {
    type: 'local',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/git_downloader.py`,
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
    ...overrides,
  };
}

function makeSandbox(provider: SandboxProvider, existingSandboxId?: string): Sandbox {
  return new Sandbox({
    provider,
    existingSandboxId,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

describe('Sandbox exec result semantics', () => {
  describe('grep exit 1 (no matches) is not a failure', () => {
    it('sets isError false for grep with no matches', async () => {
      const execCalls: SandboxExecParams[] = [];
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-1' }),
        exec: params => {
          execCalls.push(params);
          // Simulate grep finding no matches
          if (params.command.includes('grep')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'grep nonexistent file.txt' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.status).toBe('ok');
      expect(response.exit_code).toBe(1);
    });

    it('sets isError false for rg with no matches', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-2' }),
        exec: params => {
          // Simulate rg finding no matches
          if (params.command.includes('rg')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'rg nonexistent' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
    });

    it('sets isError false for git grep with no matches', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-3' }),
        exec: params => {
          // Simulate git grep finding no matches
          if (params.command.includes('git grep')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'git grep nonexistent' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
    });

    it('sets isError false and status exited for grep with a genuine error (exit 2) - never guessed at as failed', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-5' }),
        exec: params => {
          // Simulate grep error (file not found)
          if (params.command.includes('grep')) {
            return Promise.resolve({
              success: true,
              response: { exitCode: 2, result: 'grep: file.txt: No such file or directory' },
            });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'grep pattern file.txt' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(contentItem.text).status).toBe('exited');
    });

    it('sets isError false and status exited for a generic simple command with a non-zero exit (exit 1) - never guessed at as failed', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-5b' }),
        exec: params => {
          if (params.command.includes('custom-cmd')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: 'custom-cmd: bad input' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'inspect', purpose: 'inspect', command: 'custom-cmd --flag' },
        },
        { status: 'allow' },
      );

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(contentItem.text).status).toBe('exited');
    });

    it('sets isError false for diff with differences found (exit 1)', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-5c' }),
        exec: params => {
          if (params.command.includes('diff')) {
            return Promise.resolve({
              success: true,
              response: { exitCode: 1, result: '1c1\n< old\n---\n> new' },
            });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      // Bare `diff` is not on the host's inspect-command safety floor, so it needs an explicit
      // approval decision the same as any other execute-classified command.
      const result = await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'inspect', purpose: 'inspect', command: 'diff file1.txt file2.txt' },
        },
        { status: 'allow' },
      );

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(contentItem.text).status).toBe('ok');
    });

    it('sets isError false and status exited for `find` with no matches (exit 1) - find is not in the search table', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-5d' }),
        exec: params => {
          if (params.command.includes('find')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'find /missing -name "*.txt"' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(contentItem.text).status).toBe('exited');
    });

    // `command grep ...` (the bare-simple-command case that is not a search-table name) is
    // covered directly at the classifyExecStatus/buildExecResultShape level in
    // execResultSemantics.test.ts. At the Sandbox level, `command` is itself a banned
    // command-evaluator wrapper (it hides the wrapped operation from approval classification)
    // and is rejected before dispatch, so it cannot reach decorateExecResult here.
  });

  describe('"failed" is reserved for the host\'s own failures, never a command that ran', () => {
    it('reports failed when the provider kills the command after the execution timeout', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-timeout' }),
        exec: params => {
          if (params.command.includes('sleep')) {
            return Promise.resolve({
              success: false,
              error: 'Command timed out after 60s and was killed',
            });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      // Bare `sleep` is not on the host's inspect-command safety floor, so it needs an explicit
      // approval decision the same as any other execute-classified command.
      const result = await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'inspect', purpose: 'inspect', command: 'sleep 120' },
        },
        { status: 'allow' },
      );

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(true);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.status).toBe('failed');
      expect(response.error_summary).toContain('timed out');
    });

    it('reports a policy refusal as a top-level rejection before the command ever reaches the provider', async () => {
      const exec = jest.fn(() => readyExec());
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-policy' }),
        exec,
      });

      const sandbox = makeSandbox(provider);
      // HOME is set with no cwd: the preflight check refuses this before dispatch, the same as
      // any other policy refusal (a rejected command shape or a disallowed egress target).
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'echo hello', env: { HOME: '/root' } },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(true);
      expect(exec).not.toHaveBeenCalled();
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.status).toBe('failed');
      expect(response.error).toContain('HOME changes the user home');
      expect(response.error_summary).toContain('HOME changes the user home');
    });

    it('reports status failed when sandbox creation itself is rejected', async () => {
      const exec = jest.fn(() => readyExec());
      const provider = makeProvider({
        createSandbox: () => Promise.reject(new Error('sandbox creation rejected by policy')),
        exec,
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'grep pattern file.txt' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(true);
      expect(exec).not.toHaveBeenCalled();
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.status).toBe('failed');
      expect(response.error_summary).toBe("Your code couldn't run. Please try again.");
    });
  });

  describe('non-simple commands report "exited", never guessed at as ok or failed', () => {
    it('sets isError false and status exited for a search command wrapped by env', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-7' }),
        exec: params => {
          if (params.command.includes('env')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'inspect', purpose: 'inspect', command: 'env X=1 grep absent file' },
        },
        { status: 'allow' },
      );

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.status).toBe('exited');
      expect(response.exit_code).toBe(1);
    });

    it('sets isError false and status exited for a pipeline ending in grep with no matches', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-8' }),
        exec: params => {
          if (params.command.includes('|')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'cat file.txt | grep pattern' },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(contentItem.text).status).toBe('exited');
    });

    // A redirect (`grep pattern < file`) never reaches the exec provider at all: the
    // admission preflight rejects unstructured shell redirection outright for inspect/edit/
    // execute purposes. classifyExecStatus's "exited" verdict for a redirected command is
    // covered directly in execResultSemantics.test.ts and buildExecResultShape's tests.

    it('sets isError false and status exited for a search command following a failed one in a list', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-10' }),
        exec: params => {
          if (params.command.includes('&&')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'inspect', purpose: 'inspect', command: 'false && grep pattern file.txt' },
        },
        { status: 'allow' },
      );

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      expect(JSON.parse(contentItem.text).status).toBe('exited');
    });

    it("reports exited with the sentence when a pipeline's first command fails and the last, grep, returns 1", async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-11' }),
        exec: params => {
          if (params.command.includes('|')) {
            return Promise.resolve({ success: true, response: { exitCode: 1, result: '' } });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool(
        {
          name: SANDBOX_EXEC_TOOL_NAME,
          arguments: { intent: 'inspect', purpose: 'inspect', command: 'false | grep pattern' },
        },
        { status: 'allow' },
      );

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(false);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.status).toBe('exited');
      expect(response.note).toContain('the host does not interpret exit codes');
    });
  });

  describe('replace_text script failure surfaces as top-level rejection', () => {
    it('rejects when script returns JSON error body', async () => {
      const provider = makeProvider({
        createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-6' }),
        exec: params => {
          // Simulate replace_text script failure
          if (params.command.includes('replace-text.py')) {
            return Promise.resolve({
              success: true,
              response: {
                exitCode: 1,
                result: JSON.stringify({
                  error: 'Replacement text not found in file',
                  received: 'line 1\nline 2',
                  expected: 'line 3\nline 4',
                }),
              },
            });
          }
          return readyExec();
        },
      });

      const sandbox = makeSandbox(provider);
      const result = await sandbox.callTool({
        name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
        arguments: {
          file: 'src/app.ts',
          before: 'oldText',
          after: 'newText',
        },
      });

      if (!isCallToolResponseResult(result)) {
        throw new Error('expected tool result');
      }

      expect(result.result.isError).toBe(true);
      const contentItem = result.result.content[0];
      if (!contentItem || contentItem.type !== 'text') {
        throw new Error('expected text content');
      }
      const response = JSON.parse(contentItem.text);
      expect(response.error).toBeDefined();
      // Verify the error is at the top level, not nested in a success:true structure
      expect(response.success).toBeUndefined();
    });
  });
});

describe('Sandbox start failure', () => {
  it('tells the person the code could not run and to try again, without the system error', async () => {
    const provider = makeProvider({
      createSandbox: () =>
        Promise.reject(new Error("ENOENT: no such file or directory, mkdir '/data/sandboxes/abc/x'")),
      exec: () => readyExec(),
    });

    const result = await makeSandbox(provider).callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'run', purpose: 'inspect', command: 'echo hi' },
    });

    if (!isCallToolResponseResult(result)) {
      throw new Error('expected tool result');
    }
    expect(result.result.isError).toBe(true);
    const contentItem = result.result.content[0];
    if (!contentItem || contentItem.type !== 'text') {
      throw new Error('expected text content');
    }
    expect(contentItem.text).toContain("Your code couldn't run. Please try again.");
    expect(contentItem.text).not.toMatch(/ENOENT|mkdir|\/data\/sandboxes/);
  });
});
