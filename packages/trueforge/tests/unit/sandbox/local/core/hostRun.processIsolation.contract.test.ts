import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

// Assembled at runtime so secret scanners do not mistake the synthetic value for a real one.
const MARKER_VALUE = ['mayaworld', 'probe', '12345678'].join('-');

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('a sandboxed command sees only its own processes (real LocalSandboxProvider runtime)', () => {
  let parent: string;
  let sandboxId: string;
  let support: Extract<Awaited<ReturnType<typeof LocalSandboxProvider.isSupported>>, { supported: true }>;
  let marker: ChildProcess;

  beforeEach(async () => {
    const probe = await LocalSandboxProvider.isSupported();
    if (!probe.supported) {
      pending(`Local sandbox not supported: ${probe.reason}`);
      return;
    }
    support = probe;
    parent = await mkdtemp(join(tmpdir(), 'tfy-process-isolation-'));
    if (!isSrtInitialized()) {
      await initSrt({ platform: support.platform });
    }
    sandboxId = await createSandbox({ sandboxRootPath: join(parent, 'sandbox'), rootOwnership: 'create' });
    // A process outside the sandbox whose environment holds a value the sandbox must never read.
    marker = spawn('/usr/bin/env', ['sleep', '600'], {
      env: { MAYA_PROBE_SECRET: MARKER_VALUE, PATH: '/usr/bin:/bin' },
      stdio: 'ignore',
    });
  }, 120_000);

  afterEach(async () => {
    marker.kill('SIGKILL');
    await removeSandbox(sandboxId);
    await resetSrt();
    await rm(parent, { recursive: true, force: true });
  }, 60_000);

  async function runInSandbox(command: string): Promise<{ stdout: string; stderr: string }> {
    const result = await runSupervisorSession({
      sandboxRootPath: sandboxId,
      command,
      shell: support.shell,
      platform: support.platform,
      env: { PATH: '/usr/bin:/bin' },
      signal: undefined,
      timeoutMs: 60_000,
    });
    return { stdout: result.stdoutText, stderr: result.stderrText };
  }

  function markerPid(): number {
    if (marker.pid === undefined) {
      throw new Error('The marker process did not start. Run the test again.');
    }
    return marker.pid;
  }

  test('the environment of a process outside the sandbox cannot be read from inside', async () => {
    const pid = markerPid();
    const { stdout, stderr } = await runInSandbox(`cat /proc/${pid}/environ; cat /proc/${process.pid}/environ; true`);
    expect(stdout).not.toContain(MARKER_VALUE);
    expect(stdout).not.toContain('MAYA_PROBE_SECRET');
    expect(stdout).toBe('');
    expect(stderr).toContain('No such file or directory');
  });

  test('processes outside the sandbox are not listed inside', async () => {
    const pid = markerPid();
    const { stdout } = await runInSandbox('ls /proc');
    const pids = stdout.split(/\s+/).filter(entry => /^\d+$/.test(entry));
    expect(pids.length).toBeGreaterThan(0);
    // Its own shell and helpers only: a short list, never the whole machine.
    expect(pids.length).toBeLessThan(20);
    // The outside process, read by its outside number, is not a sleep in here.
    const { stdout: commandLine } = await runInSandbox(`cat /proc/${pid}/cmdline; true`);
    expect(commandLine).not.toContain('sleep');
  });

  test('process 1 inside the sandbox is the sandbox itself, not the machine', async () => {
    const { stdout } = await runInSandbox("tr '\\0' ' ' < /proc/1/cmdline");
    expect(stdout).toContain('bwrap');
  });
});
