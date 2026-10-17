import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSandbox,
  initSrt,
  isSrtInitialized,
  removeSandbox,
  resetSrt,
  runSupervisorSession,
} from '../../../../../src/sandbox/local/core/hostRun';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real token.
const TOKEN = ['ghp', 'SyntheticTokenForTestsOnly0123456789'].join('_');
const HELPERS = ['socat', 'bwrap', 'bash', 'sh'] as const;

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('a token-carrying exec never runs a workspace-planted helper (real LocalSandboxProvider runtime)', () => {
  let parent: string;
  let sandboxId: string;
  let support: Extract<Awaited<ReturnType<typeof LocalSandboxProvider.isSupported>>, { supported: true }>;
  let sawToken: string;
  let ran: string;

  beforeEach(async () => {
    const probe = await LocalSandboxProvider.isSupported();
    if (!probe.supported) {
      pending(`Local sandbox not supported: ${probe.reason}`);
      return;
    }
    support = probe;
    parent = await mkdtemp(join(tmpdir(), 'tfy-git-token-'));
    if (!isSrtInitialized()) {
      await initSrt({ platform: support.platform });
    }
    sandboxId = await createSandbox({ sandboxRootPath: join(parent, 'sandbox'), rootOwnership: 'create' });
    sawToken = join(parent, 'shim-saw-token');
    ran = join(parent, 'shim-ran');
  }, 120_000);

  afterEach(async () => {
    await removeSandbox(sandboxId);
    await resetSrt();
    await rm(parent, { recursive: true, force: true });
  }, 60_000);

  async function plantShims(): Promise<void> {
    for (const dir of ['.venv/bin', 'mcp-client/bin']) {
      await mkdir(join(sandboxId, dir), { recursive: true });
      for (const name of HELPERS) {
        const shim = join(sandboxId, dir, name);
        await writeFile(
          shim,
          `#!/bin/sh\necho ${name} >> '${ran}'\n[ -n "$TRUEFORGE_GIT_TOKEN" ] && echo ${name} >> '${sawToken}'\nexit 0\n`,
        );
        await chmod(shim, 0o755);
      }
    }
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  test('planted socat, bwrap and shell shims neither run nor see the token, and the command still completes', async () => {
    await plantShims();
    const result = await runSupervisorSession({
      sandboxRootPath: sandboxId,
      command: '/usr/bin/env /usr/bin/printenv TRUEFORGE_GIT_TOKEN',
      shell: support.shell,
      platform: support.platform,
      env: { TRUEFORGE_GIT_TOKEN: TOKEN, PATH: '/usr/bin:/bin' },
      signal: undefined,
      timeoutMs: 60_000,
    });

    expect((await exists(sawToken)) ? await readFile(sawToken, 'utf8') : '').toBe('');
    expect((await exists(ran)) ? await readFile(ran, 'utf8') : '').toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdoutText.trim()).toBe(TOKEN);
  });

  test('without a token, planted bwrap and socat shims still never run outside or inside the policy wrapper', async () => {
    await plantShims();
    const result = await runSupervisorSession({
      sandboxRootPath: sandboxId,
      command: 'echo inside',
      shell: support.shell,
      platform: support.platform,
      signal: undefined,
      timeoutMs: 60_000,
    });

    expect((await exists(ran)) ? await readFile(ran, 'utf8') : '').toBe('');
    expect(result.stdoutText.trim()).toBe('inside');
  });

  test('control: without the token the sandboxed command keeps the workspace tool directories on PATH', async () => {
    const result = await runSupervisorSession({
      sandboxRootPath: sandboxId,
      command: 'printf %s "$PATH"',
      shell: support.shell,
      platform: support.platform,
      signal: undefined,
      timeoutMs: 60_000,
    });

    expect(result.stdoutText.startsWith('.venv/bin:mcp-client/bin:')).toBe(true);
  });
});
