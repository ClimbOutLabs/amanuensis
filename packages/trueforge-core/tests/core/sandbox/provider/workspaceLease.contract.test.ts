import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandWithWorkspaceLock,
  workspaceTerminationCommand,
  type SandboxExecParams,
} from '../../../../src/core/sandbox/provider/Provider';

function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (existsSync(path)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${path}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

async function waitForFileText(input: { path: string; expected: string }): Promise<void> {
  const { path, expected } = input;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, 'utf8')).includes(expected)) {
        return;
      }
    } catch {
      // The state file is atomically installed and may not exist yet.
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}`);
}

function waitForExitWithin(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return Promise.race([
    waitForExit(child),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    }),
  ]);
}

function leaseCommand(input: { workspaceRoot: string; operationId?: string | undefined; command: string }): string {
  const params: SandboxExecParams = {
    sandboxId: 'contract-sandbox',
    command: input.command,
    workspaceLock: {
      workspaceRoot: input.workspaceRoot,
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    },
  };
  return commandWithWorkspaceLock(params).command;
}

describe('workspace lease provider contract', () => {
  it('fences new workspace commands while an abnormal-handoff termination is pending', () => {
    const command = leaseCommand({ workspaceRoot: '/repository', command: 'printf mutation' });

    expect(command).toContain('trueforge-workspace-termination');
  });

  const unixOnly = process.platform === 'win32' ? test.skip : test;

  unixOnly('terminates a timed capture before another provider replica can enter the workspace', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-workspace-lease-'));
    const workspaceRoot = join(fixtureRoot, 'repository');
    const operationId = 'handoff-operation';
    const markerPath = join(workspaceRoot, '.git', 'trueforge-evidence-control', `${operationId}.pid`);
    const admissionPath = join(fixtureRoot, 'mutation-admitted');
    const flockWrapper = join(fixtureRoot, 'flock');
    try {
      const init = spawn('git', ['init', workspaceRoot]);
      await expect(waitForExit(init)).resolves.toBe(0);
      await writeFile(flockWrapper, '#!/bin/sh\n: > "$LEASE_ADMITTED_MARKER"\nexec /usr/bin/flock "$@"\n', 'utf8');
      await chmod(flockWrapper, 0o755);
      const evidence = spawn('sh', [
        '-c',
        leaseCommand({ workspaceRoot, operationId, command: 'trap "exit 0" TERM; sleep 10' }),
      ]);
      await waitForFile(markerPath);

      const mutation = spawn('sh', ['-c', leaseCommand({ workspaceRoot, command: 'printf mutation' })], {
        env: {
          ...process.env,
          LEASE_ADMITTED_MARKER: admissionPath,
          PATH: `${fixtureRoot}:${process.env['PATH'] ?? ''}`,
        },
      });
      await waitForFile(admissionPath);
      const termination = spawn('sh', ['-c', workspaceTerminationCommand({ workspaceRoot, operationId })]);

      await expect(waitForExit(termination)).resolves.toBe(0);
      await expect(waitForExit(evidence)).resolves.not.toBe(0);
      await expect(waitForExit(mutation)).resolves.toBe(125);

      const subsequent = spawn('sh', ['-c', leaseCommand({ workspaceRoot, command: 'printf resumed' })]);
      await expect(waitForExit(subsequent)).resolves.toBe(0);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  unixOnly('admits commands arriving after a termination announcement only after it completes', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-workspace-post-termination-'));
    const workspaceRoot = join(fixtureRoot, 'repository');
    const operationId = 'post-announcement-operation';
    const workspaceLockPath = join(workspaceRoot, '.git', 'trueforge-workspace.lock');
    const statePath = join(
      workspaceRoot,
      '.git',
      'trueforge-evidence-control',
      'trueforge-workspace-termination-state',
    );
    const holderReady = join(fixtureRoot, 'holder-ready');
    const holderRelease = join(fixtureRoot, 'holder-release');
    const terminationReady = join(fixtureRoot, 'termination-ready');
    const terminationRelease = join(fixtureRoot, 'termination-release');
    const flockWrapper = join(fixtureRoot, 'flock');
    try {
      const init = spawn('git', ['init', workspaceRoot]);
      await expect(waitForExit(init)).resolves.toBe(0);
      await writeFile(
        flockWrapper,
        [
          '#!/bin/sh',
          'if test "$2" = "$TARGET_WORKSPACE_LOCK"; then',
          '  : > "$TERMINATION_READY"',
          '  while ! test -e "$TERMINATION_RELEASE"; do sleep 0.01; done',
          'fi',
          'exec /usr/bin/flock "$@"',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(flockWrapper, 0o755);

      const holder = spawn(
        'flock',
        [
          '-x',
          workspaceLockPath,
          'sh',
          '-c',
          ': > "$HOLDER_READY"; while ! test -e "$HOLDER_RELEASE"; do sleep 0.01; done',
        ],
        { env: { ...process.env, HOLDER_READY: holderReady, HOLDER_RELEASE: holderRelease } },
      );
      await waitForFile(holderReady);

      const termination = spawn('sh', ['-c', workspaceTerminationCommand({ workspaceRoot, operationId })], {
        env: {
          ...process.env,
          PATH: `${fixtureRoot}:${process.env['PATH'] ?? ''}`,
          TARGET_WORKSPACE_LOCK: workspaceLockPath,
          TERMINATION_READY: terminationReady,
          TERMINATION_RELEASE: terminationRelease,
        },
      });
      await waitForFileText({ path: statePath, expected: `${operationId}:terminating` });
      await waitForFile(terminationReady);

      const laterCommand = spawn('sh', ['-c', leaseCommand({ workspaceRoot, command: 'printf post-announcement' })]);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(laterCommand.exitCode).toBeNull();

      await writeFile(terminationRelease, '', 'utf8');
      await writeFile(holderRelease, '', 'utf8');
      await expect(waitForExit(holder)).resolves.toBe(0);
      await expect(waitForExit(termination)).resolves.toBe(0);
      await expect(waitForExit(laterCommand)).resolves.toBe(0);
    } finally {
      await writeFile(terminationRelease, '', 'utf8').catch(() => undefined);
      await writeFile(holderRelease, '', 'utf8').catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  unixOnly(
    'remembers completed terminations after later operations without reacquiring the workspace lock',
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-workspace-idempotent-'));
      const workspaceRoot = join(fixtureRoot, 'repository');
      const operationId = 'idempotent-operation';
      const workspaceLockPath = join(workspaceRoot, '.git', 'trueforge-workspace.lock');
      const holderReady = join(fixtureRoot, 'holder-ready');
      const holderRelease = join(fixtureRoot, 'holder-release');
      try {
        const init = spawn('git', ['init', workspaceRoot]);
        await expect(waitForExit(init)).resolves.toBe(0);
        const first = spawn('sh', ['-c', workspaceTerminationCommand({ workspaceRoot, operationId })]);
        await expect(waitForExit(first)).resolves.toBe(0);
        const laterOperation = spawn('sh', [
          '-c',
          workspaceTerminationCommand({ workspaceRoot, operationId: 'later-operation' }),
        ]);
        await expect(waitForExit(laterOperation)).resolves.toBe(0);

        const holder = spawn(
          'flock',
          [
            '-x',
            workspaceLockPath,
            'sh',
            '-c',
            ': > "$HOLDER_READY"; while ! test -e "$HOLDER_RELEASE"; do sleep 0.01; done',
          ],
          { env: { ...process.env, HOLDER_READY: holderReady, HOLDER_RELEASE: holderRelease } },
        );
        await waitForFile(holderReady);

        const duplicate = spawn('sh', ['-c', workspaceTerminationCommand({ workspaceRoot, operationId })]);
        await expect(waitForExitWithin(duplicate, 1_000)).resolves.toBe(0);
        await writeFile(holderRelease, '', 'utf8');
        await expect(waitForExit(holder)).resolves.toBe(0);
      } finally {
        await writeFile(holderRelease, '', 'utf8').catch(() => undefined);
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  unixOnly('fences every capture delivery after termination acknowledgement', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'trueforge-workspace-late-delivery-'));
    const workspaceRoot = join(fixtureRoot, 'repository');
    const operationId = 'late-handoff-operation';
    try {
      const init = spawn('git', ['init', workspaceRoot]);
      await expect(waitForExit(init)).resolves.toBe(0);

      const termination = spawn('sh', ['-c', workspaceTerminationCommand({ workspaceRoot, operationId })]);
      await expect(waitForExit(termination)).resolves.toBe(0);

      const delayedCapture = spawn('sh', [
        '-c',
        leaseCommand({ workspaceRoot, operationId, command: 'touch late-capture-ran' }),
      ]);
      await expect(waitForExit(delayedCapture)).resolves.toBe(125);
      const duplicateDelivery = spawn('sh', [
        '-c',
        leaseCommand({ workspaceRoot, operationId, command: 'touch duplicate-late-capture-ran' }),
      ]);
      await expect(waitForExit(duplicateDelivery)).resolves.toBe(125);
      expect(existsSync(join(workspaceRoot, 'late-capture-ran'))).toBe(false);
      expect(existsSync(join(workspaceRoot, 'duplicate-late-capture-ran'))).toBe(false);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
