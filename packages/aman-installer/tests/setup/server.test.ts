import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FakeHost } from '../../src/host/fakeHost.ts';
import type { DryRunOutcome, EngineRunner } from '../../src/setup/engine.ts';
import { parseEvents } from '../../src/setup/events.ts';
import { runDirFor } from '../../src/setup/runs.ts';
import { runSetup, type SetupDeps } from '../../src/setup/setup.ts';
import type { InstanceRecord, ReleaseRecord, StateStore, StateSummary } from '../../src/state/state.ts';

const GIB = 1024 * 1024 * 1024;

const PASS_EVENTS = [
  '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
  '{"type":"step_result","name":"Linux on x86_64","result":"done","phase":"Checking this computer","elapsed_seconds":0}',
  '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"A dry run: only the plan above was printed.","elapsed_seconds":0}',
].join('\n');

const BLOCK_EVENTS = [
  '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
  '{"type":"warning","text":"Docker Desktop is not connected to this WSL distro, so Docker did not answer.","next":"Open Docker Desktop and choose Settings, then Resources, then WSL Integration.","elapsed_seconds":0}',
  '{"type":"final_result","result":"failed","step":"Checking this computer","phase":"Checking this computer","verdict_kind":"stopped","verdict":"That needs fixing first.","elapsed_seconds":0}',
].join('\n');

const PLAN_STDOUT = `The plan

  > to do        Create the folder for Aman's own files
  ! needs admin  Set up the sandbox on this computer

  First-run downloads (approximate):
       700 MB  Ubuntu base image for the app and its helpers (docker.io)
    total: about 700 MB (0.7 GB)
`;

const SUCCESS_EVENTS = [
  '{"type":"phase_start","name":"Building the app","index":4,"total":6,"elapsed_seconds":1}',
  '{"type":"step_start","name":"Building the Aman app (this might take a while)","phase":"Building the app","elapsed_seconds":1}',
  '{"type":"step_result","name":"Built the Aman app","result":"done","phase":"Building the app","elapsed_seconds":5}',
  '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"Ready. Instance main is running.","elapsed_seconds":6}',
].join('\n');

const FAILED_EVENTS = [
  '{"type":"phase_start","name":"Starting services","index":5,"total":6,"elapsed_seconds":1}',
  '{"type":"step_start","name":"Start the app","phase":"Starting services","elapsed_seconds":1}',
  '{"type":"step_result","name":"Start the app","result":"failed","phase":"Starting services","elapsed_seconds":2}',
  '{"type":"final_result","result":"failed","step":"Start the app","phase":"Starting services","verdict_kind":"stopped","verdict":"Start the app did not finish.","elapsed_seconds":2}',
].join('\n');

class FakeEngine implements EngineRunner {
  dryRunCalls: { args: readonly string[] }[] = [];
  installCalls: { args: readonly string[]; stdinLines: readonly string[] }[] = [];
  dockerCalls = 0;
  checksText = PASS_EVENTS;
  checksExit = 0;
  installEventsText = SUCCESS_EVENTS;
  installPid = 0;

  async dryRun(args: readonly string[]): Promise<DryRunOutcome> {
    this.dryRunCalls.push({ args });
    if (args.includes('--email')) {
      return { exitCode: 0, stdout: PLAN_STDOUT, stderr: '', events: parseEvents(PASS_EVENTS) };
    }
    return { exitCode: this.checksExit, stdout: '', stderr: '', events: parseEvents(this.checksText) };
  }

  async startInstall(options: {
    args: readonly string[];
    stdinLines: readonly string[];
    eventsFile: string;
    logFile: string;
  }): Promise<{ pid: number }> {
    this.installCalls.push({ args: options.args, stdinLines: options.stdinLines });
    await writeFile(options.eventsFile, this.installEventsText);
    await writeFile(options.logFile, 'the run log\n');
    return { pid: this.installPid };
  }

  async startDocker(): Promise<{ pid: number }> {
    this.dockerCalls += 1;
    return { pid: this.installPid };
  }

  async qrText(text: string): Promise<string | null> {
    return `QR for ${text}`;
  }
}

function emptySummary(): StateSummary {
  return {
    release: null,
    releaseUnreadable: false,
    previousRelease: null,
    instances: [],
    backups: [],
    backupEntries: [],
    backupsMode: null,
    backupsModeTimeSeconds: null,
    certificateAuthority: { certPresent: false, keyMode: null, fingerprint: null, fingerprintHasContent: false },
    sourceCheckout: null,
    installedAppImage: null,
  };
}

function installedSummary(): StateSummary {
  const release: ReleaseRecord = {
    schema: '1',
    sourceRef: null,
    appImage: null,
    sttImage: null,
    calendarImage: null,
    dexImage: null,
    mailEmailImage: null,
  };
  const instance: InstanceRecord = {
    name: 'main',
    entries: [
      { key: 'public_url', value: 'http://127.0.0.1:8791' },
      { key: 'origins', value: 'http://192.168.1.20:8791,http://127.0.0.1:8791' },
    ],
  };
  return { ...emptySummary(), release, instances: [instance] };
}

class FakeStore implements StateStore {
  summary: StateSummary = emptySummary();
  async readSummary(): Promise<StateSummary> {
    return this.summary;
  }
  async readCaCertificate(): Promise<string | null> {
    return null;
  }
  refreshCache(): void {}
  async writeInstance(): Promise<boolean> {
    return false;
  }
  async setInstanceValue(): Promise<boolean> {
    return false;
  }
  async removeInstance(): Promise<void> {}
  async writeRelease(): Promise<boolean> {
    return false;
  }
  async setBackupsMode(): Promise<boolean> {
    return false;
  }
}

interface Harness {
  deps: SetupDeps;
  engine: FakeEngine;
  store: FakeStore;
  stateHome: string;
  tempRoot: string;
  printed: string[];
}

async function makeHarness(options?: { dockerOk?: boolean }): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'aman-wizard-server-'));
  const stateHome = join(base, 'state-home');
  const tempRoot = join(base, 'temp');
  await mkdir(stateHome, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  const engine = new FakeEngine();
  const store = new FakeStore();
  const printed: string[] = [];
  const deps: SetupDeps = {
    host: new FakeHost({ kind: 'linux', memoryBytes: 16 * GIB }),
    store,
    engine,
    stateHome,
    dmiDir: join(base, 'dmi'),
    tempRoot,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    dockerCheck: () => Promise.resolve(options?.dockerOk ?? true),
    openBrowser: () => Promise.resolve(true),
    print: (line: string) => {
      printed.push(line);
    },
  };
  return { deps, engine, store, stateHome, tempRoot, printed };
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('t') ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function call(
  handleUrl: string,
  path: string,
  options?: { token?: string | null; body?: unknown },
): Promise<{ status: number; data: Record<string, unknown>; text: string }> {
  const token = options?.token === null ? null : (options?.token ?? tokenOf(handleUrl));
  const url = `http://127.0.0.1:${new URL(handleUrl).port}${path}${token !== null ? `?t=${token}` : ''}`;
  const init: RequestInit = {
    method: options?.body !== undefined ? 'POST' : 'GET',
    headers: { connection: 'close', ...(options?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
  };
  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      data = parsed;
    }
  } catch {
    data = {};
  }
  return { status: response.status, data, text };
}

const ANSWERS = {
  email: 'you@example.com',
  yourName: 'You',
  backups: 'daily',
  reach: 'network',
  installDocker: false,
  advanced: {
    emailProvider: 'icloud',
    emailAddress: 'you@icloud.com',
    emailImapHost: '',
    emailImapPort: '',
    emailSmtpHost: '',
    emailSmtpPort: '',
    calendarProvider: 'icloud',
    calendarEmail: 'you@icloud.com',
    calendarUrl: '',
    calendarUser: '',
    tokenFactoryModel: 'model-x',
    tokenFactoryDailyCap: '',
  },
};

const SECRETS = {
  password: 'Sentinel!234',
  emailPassword: 'em-Sentinel!234',
  calendarPassword: 'cal-Sentinel!234',
  tokenFactoryKey: 'tf-Sentinel!234',
};

function livePid(): { pid: number; stop: () => void } {
  const child: ChildProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
  child.unref();
  return {
    pid: child.pid ?? 0,
    stop: () => {
      child.kill('SIGKILL');
    },
  };
}

test('the server refuses requests without the token and serves the page with it', async () => {
  const harness = await makeHarness();
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    assert.match(harness.printed.join('\n'), /Setup page: http:\/\/127\.0\.0\.1:/);
    const noToken = await call(handle.url, '/', { token: null });
    assert.equal(noToken.status, 403);
    const wrongToken = await call(handle.url, '/api/state', { token: 'wrong' });
    assert.equal(wrongToken.status, 403);
    const page = await call(handle.url, '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /s-welcome/);
    const state = await call(handle.url, '/api/state');
    assert.equal(state.data['mode'], 'fresh');
  } finally {
    handle.close();
    await handle.closed;
  }
});

test('a full run: checks, plan, install, done, and the secrets nowhere they must not be', async () => {
  const harness = await makeHarness();
  const sleeper = livePid();
  harness.engine.installPid = sleeper.pid;
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    const checks = await call(handle.url, '/api/checks', { body: {} });
    assert.equal(checks.data['blocked'], false);
    const plan = await call(handle.url, '/api/plan', { body: { answers: ANSWERS, secrets: SECRETS } });
    assert.equal(plan.status, 200);
    const rows = plan.data['rows'];
    assert.ok(Array.isArray(rows) && rows.some(row => isRecord(row) && row['state'] === 'admin'));
    const started = await call(handle.url, '/api/install', { body: { planId: plan.data['planId'] } });
    assert.deepEqual(started.data, { started: true });
    assert.equal(harness.engine.installCalls.length, 1);
    const installCall = harness.engine.installCalls[0];
    assert.ok(installCall !== undefined);
    // The plan's admin step rides along as its consent flag.
    assert.ok(installCall.args.includes('--sandbox-root'));
    assert.ok(installCall.args.includes('--yes'));
    // The secrets went on stdin, in the installer's order, and nowhere else.
    assert.deepEqual(installCall.stdinLines, [
      SECRETS.password,
      SECRETS.tokenFactoryKey,
      SECRETS.calendarPassword,
      SECRETS.emailPassword,
    ]);
    const runDir = runDirFor(harness.stateHome, harness.tempRoot);
    const kept = [
      installCall.args.join('\n'),
      await readFile(join(runDir, 'run.json'), 'utf8'),
      await readFile(join(runDir, 'events.jsonl'), 'utf8'),
      await readFile(join(runDir, 'run.log'), 'utf8'),
      handle.url,
      checks.text,
      plan.text,
      started.text,
    ].join('\n');
    for (const sentinel of Object.values(SECRETS)) {
      assert.ok(!kept.includes(sentinel), `a secret was kept: ${sentinel}`);
    }
    // The plan is spent: the server holds no second use of the secrets.
    const again = await call(handle.url, '/api/install', { body: { planId: plan.data['planId'] } });
    assert.equal(again.status, 400);
    // Done reads the fresh state: the address, the phone address, its QR.
    harness.store.summary = installedSummary();
    const progress = await call(handle.url, '/api/progress');
    assert.equal(progress.data['status'], 'succeeded');
    const done = progress.data['done'];
    assert.ok(isRecord(done));
    assert.equal(done['publicUrl'], 'http://127.0.0.1:8791');
    assert.equal(done['phoneUrl'], 'http://192.168.1.20:8791');
    assert.equal(done['qr'], 'QR for http://192.168.1.20:8791');
    assert.equal(done['warning'], false);
  } finally {
    sleeper.stop();
    handle.close();
    await handle.closed;
  }
});

test('a block on the checks screen keeps the plan, and so the install, unmakeable', async () => {
  const harness = await makeHarness();
  harness.engine.checksText = BLOCK_EVENTS;
  harness.engine.checksExit = 1;
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    const checks = await call(handle.url, '/api/checks', { body: {} });
    assert.equal(checks.data['blocked'], true);
    const plan = await call(handle.url, '/api/plan', { body: { answers: ANSWERS, secrets: SECRETS } });
    assert.equal(plan.status, 400);
    assert.equal(harness.engine.installCalls.length, 0);
  } finally {
    handle.close();
    await handle.closed;
  }
});

test('Check again runs the preflight once more and refreshes the asked row', async () => {
  const harness = await makeHarness();
  harness.engine.checksText = [
    '{"type":"phase_start","name":"Checking this computer","index":1,"total":6,"elapsed_seconds":0}',
    '{"type":"step_result","name":"Linux on x86_64","result":"done","phase":"Checking this computer","elapsed_seconds":0}',
    '{"type":"warning","text":"Docker has 6.5 GB of memory, under the 8 GB that suits Aman best.","next":"Raise it in the Docker settings.","elapsed_seconds":0}',
    '{"type":"final_result","result":"success","verdict_kind":"ok","verdict":"ok","elapsed_seconds":0}',
  ].join('\n');
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    const checks = await call(handle.url, '/api/checks', { body: {} });
    const rows = checks.data['rows'];
    assert.ok(Array.isArray(rows));
    let warnId: string | null = null;
    for (const row of rows) {
      if (isRecord(row) && row['state'] === 'warn' && typeof row['id'] === 'string') {
        warnId = row['id'];
      }
    }
    assert.ok(warnId !== null);
    const before = harness.engine.dryRunCalls.length;
    const rechecked = await call(handle.url, '/api/checks/recheck', { body: { id: warnId } });
    assert.equal(harness.engine.dryRunCalls.length, before + 1);
    const newRows = rechecked.data['rows'];
    assert.ok(Array.isArray(newRows) && newRows.length === rows.length);
  } finally {
    handle.close();
    await handle.closed;
  }
});

test('a second setup against a live run attaches instead of starting over', async () => {
  const harness = await makeHarness();
  const sleeper = livePid();
  harness.engine.installPid = sleeper.pid;
  harness.engine.installEventsText = [
    '{"type":"phase_start","name":"Building the app","index":4,"total":6,"elapsed_seconds":1}',
    '{"type":"step_start","name":"Building the Aman app (this might take a while)","phase":"Building the app","elapsed_seconds":1}',
  ].join('\n');
  const first = await runSetup(harness.deps, { noBrowser: true });
  try {
    await call(first.url, '/api/checks', { body: {} });
    const plan = await call(first.url, '/api/plan', { body: { answers: ANSWERS, secrets: SECRETS } });
    await call(first.url, '/api/install', { body: { planId: plan.data['planId'] } });
    first.close();
    await first.closed;
    const second = await runSetup(harness.deps, { noBrowser: true });
    try {
      assert.equal(second.mode, 'attach');
      const state = await call(second.url, '/api/state');
      assert.equal(state.data['mode'], 'attach');
      const progress = await call(second.url, '/api/progress');
      assert.equal(progress.data['status'], 'running');
      assert.equal(harness.engine.installCalls.length, 1);
    } finally {
      second.close();
      await second.closed;
    }
  } finally {
    sleeper.stop();
    first.close();
  }
});

test('an installed machine gets the changes-nothing answer', async () => {
  const harness = await makeHarness();
  harness.store.summary = installedSummary();
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    assert.equal(handle.mode, 'already');
    const state = await call(handle.url, '/api/state');
    assert.equal(state.data['mode'], 'already');
    assert.equal(state.data['publicUrl'], 'http://127.0.0.1:8791');
    const install = await call(handle.url, '/api/install', { body: { planId: 'anything' } });
    assert.equal(install.status, 400);
    assert.equal(harness.engine.installCalls.length, 0);
  } finally {
    handle.close();
    await handle.closed;
  }
});

test('a live lock that is not this wizard says an install is already running', async () => {
  const harness = await makeHarness();
  const sleeper = livePid();
  try {
    const lockDir = join(harness.stateHome, 'state', 'lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner'), 'install.sh 123\n');
    await writeFile(join(lockDir, 'beat'), `${String(Math.floor(Date.now() / 1000))}\n`);
    await writeFile(join(lockDir, 'pid'), `${String(sleeper.pid)}\n`);
    const handle = await runSetup(harness.deps, { noBrowser: true });
    try {
      assert.equal(handle.mode, 'locked');
      // The lock is still there, untouched.
      assert.equal(await readFile(join(lockDir, 'pid'), 'utf8'), `${String(sleeper.pid)}\n`);
    } finally {
      handle.close();
      await handle.closed;
    }
  } finally {
    sleeper.stop();
  }
});

test('a failed run shows its step, asks for the password again, and Try again reruns it', async () => {
  const harness = await makeHarness({ dockerOk: false });
  const sleeper = livePid();
  harness.engine.installPid = sleeper.pid;
  harness.engine.installEventsText = FAILED_EVENTS;
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    await call(handle.url, '/api/checks', { body: {} });
    const plan = await call(handle.url, '/api/plan', { body: { answers: ANSWERS, secrets: SECRETS } });
    await call(handle.url, '/api/install', { body: { planId: plan.data['planId'] } });
    const progress = await call(handle.url, '/api/progress');
    assert.equal(progress.data['status'], 'failed');
    assert.equal(progress.data['failedStep'], 'Start the app');
    assert.equal(progress.data['needsPassword'], true);
    assert.equal(progress.data['dockerDown'], true);
    const noPassword = await call(handle.url, '/api/retry', { body: { password: '' } });
    assert.equal(noPassword.status, 400);
    const docker = await call(handle.url, '/api/start-docker', { body: {} });
    assert.deepEqual(docker.data, { started: true });
    assert.equal(harness.engine.dockerCalls, 1);
    harness.engine.installEventsText = SUCCESS_EVENTS;
    const retry = await call(handle.url, '/api/retry', { body: { password: 'Newpass!234' } });
    assert.deepEqual(retry.data, { started: true });
    assert.equal(harness.engine.installCalls.length, 2);
    assert.equal(harness.engine.installCalls[1]?.stdinLines[0], 'Newpass!234');
  } finally {
    sleeper.stop();
    handle.close();
    await handle.closed;
  }
});

test('a cloud machine is known to the page, from the hardware names', async () => {
  const harness = await makeHarness();
  await mkdir(harness.deps.dmiDir, { recursive: true });
  await writeFile(join(harness.deps.dmiDir, 'sys_vendor'), 'Amazon EC2\n');
  const handle = await runSetup(harness.deps, { noBrowser: true });
  try {
    const state = await call(handle.url, '/api/state');
    assert.equal(state.data['cloudVm'], true);
  } finally {
    handle.close();
    await handle.closed;
  }
});
