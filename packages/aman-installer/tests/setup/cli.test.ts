import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli, type CliDeps } from '../../src/cli.ts';
import { FakeHost } from '../../src/host/fakeHost.ts';
import { HELP_LINES } from '../../src/messages.ts';
import { RecordingProcessRunner, StubProcessRunner } from '../../src/runner/processRunner.ts';
import type { DryRunOutcome, EngineRunner } from '../../src/setup/engine.ts';
import { parseEvents } from '../../src/setup/events.ts';
import type { SetupDeps } from '../../src/setup/setup.ts';
import { folderBackend } from '../../src/state/folderBackend.ts';
import { createStateStore } from '../../src/state/state.ts';

const GIB = 1024 * 1024 * 1024;

class StubEngine implements EngineRunner {
  async dryRun(): Promise<DryRunOutcome> {
    return { exitCode: 0, stdout: '', stderr: '', events: parseEvents('') };
  }
  async startInstall(): Promise<{ pid: number }> {
    return { pid: 0 };
  }
  async startDocker(): Promise<{ pid: number }> {
    return { pid: 0 };
  }
  async qrText(): Promise<string | null> {
    return null;
  }
}

interface CliHarness {
  deps: CliDeps;
  printed: string[];
  openedUrls: string[];
}

async function makeCli(options: { installed: boolean; withSetup: boolean }): Promise<CliHarness> {
  const base = await mkdtemp(join(tmpdir(), 'aman-wizard-cli-'));
  const home = join(base, 'home');
  if (options.installed) {
    await mkdir(join(home, 'state', 'instances'), { recursive: true });
    await writeFile(join(home, 'state', 'instances', 'main.conf'), 'public_url=http://127.0.0.1:8791\n');
  }
  const printed: string[] = [];
  const openedUrls: string[] = [];
  const store = createStateStore(folderBackend(home));
  const print = (line: string) => {
    printed.push(line);
  };
  const deps: CliDeps = {
    host: new FakeHost({ kind: 'linux', memoryBytes: 16 * GIB }),
    runner: new RecordingProcessRunner(new StubProcessRunner(new Map())),
    store,
    print,
    now: () => Math.floor(Date.now() / 1000),
    homeDir: home,
    stateHome: home,
    osReleasePath: join(home, 'os-release'),
    dockerConfigDir: join(home, '.docker'),
    appService: 'app',
  };
  if (options.withSetup) {
    const setup: SetupDeps = {
      host: deps.host,
      store,
      engine: new StubEngine(),
      stateHome: home,
      dmiDir: join(base, 'dmi'),
      tempRoot: join(base, 'temp'),
      nowSeconds: deps.now,
      dockerCheck: () => Promise.resolve(true),
      openBrowser: (url: string) => {
        openedUrls.push(url);
        return Promise.resolve(true);
      },
      print,
    };
    deps.setup = setup;
  }
  return { deps, printed, openedUrls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function quitAt(url: string): Promise<void> {  const token = new URL(url).searchParams.get('t') ?? '';
  const port = new URL(url).port;
  await fetch(`http://127.0.0.1:${port}/api/quit?t=${token}`, {
    method: 'POST',
    headers: { connection: 'close', 'content-type': 'application/json' },
    body: '{}',
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('aman setup --no-browser prints the page address and serves until Close', async () => {
  const { deps, printed } = await makeCli({ installed: false, withSetup: true });
  const running = runCli(['setup', '--no-browser'], deps);
  await waitFor(() => printed.some(line => line.startsWith('Setup page: http://127.0.0.1:')));
  const line = printed.find(entry => entry.startsWith('Setup page: '));
  assert.ok(line !== undefined);
  const url = line.slice('Setup page: '.length);
  const parsed = new URL(url);
  const token = parsed.searchParams.get('t') ?? '';
  assert.ok(token !== '');
  const stateResponse = await fetch(`http://127.0.0.1:${parsed.port}/api/state?t=${token}`, {
    headers: { connection: 'close' },
  });
  const state: unknown = await stateResponse.json();
  assert.ok(isRecord(state));
  assert.equal(state['mode'], 'fresh');
  await quitAt(url);
  assert.equal(await running, 0);
});

test('aman with no command opens the wizard when nothing is installed', async () => {
  const { deps, openedUrls } = await makeCli({ installed: false, withSetup: true });
  const running = runCli([], deps);
  await waitFor(() => openedUrls.length === 1);
  assert.equal(openedUrls.length, 1);
  await quitAt(openedUrls[0] ?? '');
  assert.equal(await running, 0);
});

test('aman with no command prints what it can do when Aman is installed', async () => {
  const { deps, printed, openedUrls } = await makeCli({ installed: true, withSetup: true });
  const exitCode = await runCli([], deps);
  assert.equal(exitCode, 0);
  assert.deepEqual(printed, [...HELP_LINES]);
  assert.equal(openedUrls.length, 0);
});

test('aman setup on a copy without the wizard wired answers plainly', async () => {
  const { deps, printed } = await makeCli({ installed: false, withSetup: false });
  const exitCode = await runCli(['setup'], deps);
  assert.equal(exitCode, 1);
  assert.match(printed.join('\n'), /setup/);
});
