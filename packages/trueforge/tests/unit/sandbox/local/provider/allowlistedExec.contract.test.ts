import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import { isCallToolResponseResult } from '../../../../../../trueforge-core/src/core/mcp/IMCPServer';
import {
  createSentinelHostContext,
  defaultSentinelServices,
} from '../../../../../../trueforge-core/src/core/permissions/context';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox } from '../../../../../../trueforge-core/src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../../../../trueforge-core/src/core/tracing/NoopAgentTracing';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

const PLANTED_OUTPUT = 'PLANTED-PROGRAM-RAN';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('allowlisted commands run the program that was classified (real LocalSandboxProvider)', () => {
  let parent: string;
  let provider: LocalSandboxProvider;
  let sandboxId: string;
  let sandbox: Sandbox;

  beforeEach(async () => {
    const support = await LocalSandboxProvider.isSupported();
    if (!support.supported) {
      pending(`Local sandbox not supported: ${support.reason}`);
    }
    if (!support.supported) {
      throw new Error(support.reason);
    }
    parent = await mkdtemp(join(tmpdir(), 'tfy-allowlisted-exec-'));
    const codeModeSocketParentPath = join(tmpdir(), 'cm');
    await mkdir(codeModeSocketParentPath, { recursive: true, mode: 0o700 });
    provider = new LocalSandboxProvider({
      sandboxRootPathParent: parent,
      codeModeSocketParentPath,
      support,
      logger: createLogger({ silent: true }),
    });
    ({ sandboxId } = await provider.createSandbox());
    sandbox = new Sandbox({
      provider,
      existingSandboxId: sandboxId,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: createLogger({ silent: true }),
      tracing: NOOP_AGENT_TRACING,
      sentinel: createSentinelHostContext({
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        workspace_cwd: sandboxId,
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
    });
  }, 120_000);

  afterEach(async () => {
    await provider.dispose();
    await rm(parent, { recursive: true, force: true });
  }, 60_000);

  async function plant(relativePath: string, marker: string): Promise<void> {
    const target = join(sandboxId, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, `#!/bin/sh\necho ${PLANTED_OUTPUT}\necho "$@" >> '${marker}'\n`);
    await chmod(target, 0o755);
  }

  async function run(command: string): Promise<{ asksForApproval: boolean; text: string }> {
    const response = await sandbox.callTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'inspect', purpose: 'inspect', command, cwd: sandboxId },
    });
    if (!isCallToolResponseResult(response)) {
      return { asksForApproval: true, text: '' };
    }
    const content = response.result.content[0];
    return { asksForApproval: false, text: content?.type === 'text' ? content.text : '' };
  }

  test.each([
    ['ls hello.txt', '.venv/bin/ls', 'hello.txt'],
    ['ls -l hello.txt', 'mcp-client/bin/ls', 'hello.txt'],
    ['cat hello.txt', '.venv/bin/cat', 'hello'],
    ['nice ls hello.txt', '.venv/bin/nice', 'hello.txt'],
    ['ls hello.txt', '.venv/bin/flock', 'hello.txt'],
    ['ls hello.txt', 'mcp-client/bin/sh', 'hello.txt'],
  ])('a planted program cannot stand in for the safe `%s`', async (command, plantedAt, realOutput) => {
    const marker = join(sandboxId, 'planted-ran');
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    await plant(plantedAt, marker);
    const outcome = await run(command);
    // A run that aborts or asks would also lack the planted output, so the real program's output must be present.
    expect(outcome.asksForApproval).toBe(false);
    expect(outcome.text).toContain(realOutput);
    expect(outcome.text).not.toContain(PLANTED_OUTPUT);
    // Host bookkeeping may still call a bare name; the user's command and its operand must never reach it.
    const calls = (await exists(marker)) ? await readFile(marker, 'utf8') : '';
    expect(calls).not.toContain('hello.txt');
  });

  test('the real program still runs silently and its output is returned', async () => {
    await writeFile(join(sandboxId, 'hello.txt'), 'hello\n');
    const outcome = await run('cat hello.txt');
    expect(outcome.asksForApproval).toBe(false);
    expect(outcome.text).toContain('hello');
    expect(await readFile(join(sandboxId, 'hello.txt'), 'utf8')).toBe('hello\n');
  });
});
