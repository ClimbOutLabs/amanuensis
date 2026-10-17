import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriverRunParams } from '../../../../src/core/sandbox/driver/IsolationDriver';
import { ISOLATION_REFUSED_MARKER, OUTPUT_EXCEEDED_MARKER } from '../../../../src/core/sandbox/driver/IsolationDriver';
import { runCodeStatusFromReadiness } from '../../../../src/core/sandbox/driver/runCodeStatus';
import { SlotRunCodeRequestSchema } from '../../../../src/core/sandbox/slots/slotContract';
import { attestationProblem, SLOT_NOT_READY_MESSAGE, SlotDriver } from '../../../../src/core/sandbox/slots/SlotDriver';
import { makeSilentLogger } from '../../harnessMocks';
import { attestation, bodyOf, errorBody, FakeAgent, type FakeHandler } from './fakeAgent';

const RUN_ID = 'c'.repeat(32);

function runResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exit_code: 0,
    stdout: 'out',
    stderr: '',
    terminated_by: 'completed',
    internal_error: '',
    files_out: [],
    warnings: [],
    duration_ms: 5,
    ...overrides,
  };
}

describe('attestationProblem', () => {
  const now = Date.now();

  test('passes when every required check passes', () => {
    expect(attestationProblem(attestation(), now)).toBeUndefined();
  });

  test('names a failing check', () => {
    expect(attestationProblem(attestation({ failing: ['apparmor'] }), now)).toBe('apparmor: apparmor is wrong');
  });

  test('a required check that is not reported fails closed', () => {
    expect(attestationProblem(attestation({ omitted: ['seccomp'] }), now)).toContain('seccomp: not reported');
  });

  test('a check reported twice fails, so a later passing copy cannot hide a failing one', () => {
    expect(attestationProblem(attestation({ duplicated: 'network' }), now)).toBe('network: reported more than once');
  });

  test('an agent that says not ok with every check passing still fails', () => {
    expect(attestationProblem({ ...attestation(), ok: false }, now)).toBe('the agent reported a failed attestation');
  });

  test('a stale or future attestation is not current', () => {
    const old = attestation({ checkedAt: new Date(now - 16 * 60_000) });
    const future = attestation({ checkedAt: new Date(now + 5 * 60_000) });
    expect(attestationProblem(old, now)).toBe('the attestation is not current');
    expect(attestationProblem(future, now)).toBe('the attestation is not current');
    expect(attestationProblem({ ...attestation(), checked_at: 'yesterday' }, now)).toBe(
      'the attestation is not current',
    );
  });

  test('a different agent build, gVisor release or platform is refused', () => {
    const base = attestation();
    expect(attestationProblem({ ...base, agent_version: '0.0.1' }, now)).toContain('agent version 0.0.1');
    expect(
      attestationProblem({ ...base, facts: { ...base.facts, runsc_version: 'runsc version other' } }, now),
    ).toContain('gVisor is');
    expect(attestationProblem({ ...base, facts: { ...base.facts, platform: 'ptrace' } }, now)).toContain(
      'platform is ptrace',
    );
  });
});

describe('SlotDriver', () => {
  const agents: FakeAgent[] = [];
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'slot-driver-'));
  });

  afterEach(async () => {
    await Promise.all(agents.splice(0).map(agent => agent.stop()));
    await rm(workDir, { recursive: true, force: true });
  });

  async function driverFor(handlers: FakeHandler[]): Promise<{ driver: SlotDriver; agents: FakeAgent[] }> {
    const started = handlers.map(handler => new FakeAgent(handler));
    agents.push(...started);
    const socketPaths = await Promise.all(started.map(agent => agent.start()));
    return {
      driver: new SlotDriver({
        socketPaths,
        logger: makeSilentLogger(),
        now: undefined,
        sleepMs: () => Promise.resolve(),
      }),
      agents: started,
    };
  }

  async function params(): Promise<DriverRunParams> {
    const ingressDir = join(workDir, 'ingress');
    const scratchDir = join(workDir, 'scratch');
    const egressDir = join(workDir, 'egress');
    await Promise.all([ingressDir, scratchDir, egressDir].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(join(ingressDir, '__runcode_main.py'), 'print(1)');
    await writeFile(join(ingressDir, 'data.csv'), 'a,b');
    return {
      language: 'python',
      code: 'print(1)',
      filesIn: [],
      ingressDir,
      scratchDir,
      egressDir,
      timeoutMs: 30_000,
      memoryMb: 2048,
      diskMb: 100,
      runId: RUN_ID,
      env: {},
      sandboxIdentity: { uid: 1, gid: 1, chownRunDirs: false },
      signal: undefined,
    };
  }

  const healthy: FakeHandler = () => ({ status: 200, body: { busy: false, sessions: 0, attestation: attestation() } });

  test('ready when one slot attests, even if another is unreachable', async () => {
    const { driver } = await driverFor([healthy]);
    const bad = new SlotDriver({
      socketPaths: [join(workDir, 'missing.sock')],
      logger: makeSilentLogger(),
      now: undefined,
      sleepMs: undefined,
    });
    expect(await driver.ensureReady()).toEqual({ ready: true });
    expect(await bad.ensureReady()).toMatchObject({ ready: false, error_code: 'slots_unavailable' });
  });

  test('every slot failing its checks is isolation_refused and gets the plain message, the cause going to the log', async () => {
    const refusing: FakeHandler = () => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation({ failing: ['apparmor'] }) },
    });
    const { driver } = await driverFor([refusing, refusing]);
    const readiness = await driver.ensureReady();
    expect(readiness).toMatchObject({ ready: false, reason: 'isolation_refused' });
    expect(!readiness.ready && readiness.error).toBe(SLOT_NOT_READY_MESSAGE);
    expect(runCodeStatusFromReadiness(readiness).state).toBe('isolation_refused');
  });

  test('slots that are not running are slots_unavailable with the repair command', async () => {
    const driver = new SlotDriver({
      socketPaths: [join(workDir, 'missing.sock')],
      logger: makeSilentLogger(),
      now: undefined,
      sleepMs: undefined,
    });
    const readiness = await driver.ensureReady();
    expect(readiness).toMatchObject({ ready: false, error_code: 'slots_unavailable' });
    expect(!readiness.ready && readiness.error).toBe(SLOT_NOT_READY_MESSAGE);
    expect(!readiness.ready && readiness.verbatim).toBe(true);
    expect(!readiness.ready && readiness.error).not.toMatch(/slot|daemon|docker|sandbox backend/i);
    expect(runCodeStatusFromReadiness(readiness).state).toBe('slots_unavailable');
  });

  test('run sends the program from ingress and writes result files where the wrapper harvests them', async () => {
    const reply: FakeHandler = () => ({
      status: 200,
      body: runResponse({
        stdout: 'hello',
        files_out: [
          { dir: 'egress', name: 'out.txt', content_base64: Buffer.from('E').toString('base64') },
          { dir: 'scratch', name: 'tmp.txt', content_base64: Buffer.from('S').toString('base64') },
          { dir: 'egress', name: '../escape', content_base64: Buffer.from('X').toString('base64') },
        ],
        warnings: ['agent warning'],
      }),
    });
    const { driver, agents: started } = await driverFor([reply]);
    const input = await params();
    const result = await driver.run(input);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello', terminatedBy: 'completed' });
    expect(await readFile(join(input.egressDir, 'out.txt'), 'utf8')).toBe('E');
    expect(await readFile(join(input.scratchDir, 'tmp.txt'), 'utf8')).toBe('S');
    expect(result.harvestWarnings).toEqual(['agent warning', 'Skipped a result file with an invalid name.']);
    const sent = bodyOf(started[0]?.requests[0], SlotRunCodeRequestSchema);
    expect(sent.argv).toEqual(['python3', '/ingress/__runcode_main.py']);
    expect(sent.files_in.map(file => file.name).sort()).toEqual(['__runcode_main.py', 'data.csv']);
    expect(sent.timeout_ms).toBe(29_250);
  });

  test('maps the agent terminations onto the driver terminations', async () => {
    const cases: [string, string, string | undefined][] = [
      ['timeout', 'timeout', undefined],
      ['oom', 'oom', undefined],
      ['disk_exceeded', 'disk', 'disk quota exceeded during run'],
      ['output_exceeded', 'killed', OUTPUT_EXCEEDED_MARKER],
    ];
    for (const [agentName, driverName, internal] of cases) {
      const reply: FakeHandler = () => ({ status: 200, body: runResponse({ terminated_by: agentName }) });
      const { driver } = await driverFor([reply]);
      const result = await driver.run(await params());
      expect(result.terminatedBy).toBe(driverName);
      if (internal !== undefined) {
        expect(result.internalError).toContain(internal);
      }
    }
  });

  test('a busy slot is skipped for the next one', async () => {
    const busy: FakeHandler = () => ({ status: 429, body: errorBody('busy', 'busy') });
    const free: FakeHandler = () => ({ status: 200, body: runResponse({ stdout: 'second' }) });
    const { driver } = await driverFor([busy, free]);
    expect((await driver.run(await params())).stdout).toBe('second');
  });

  test('an isolation refusal from every slot carries the refusal marker and the repair command', async () => {
    const refuse: FakeHandler = () => ({
      status: 412,
      body: errorBody('isolation_refused', 'apparmor: wrong profile'),
    });
    const { driver } = await driverFor([refuse, refuse]);
    const result = await driver.run(await params());
    expect(result.internalError?.startsWith(ISOLATION_REFUSED_MARKER)).toBe(true);
    expect(result.internalError).toContain('apparmor: wrong profile');
    expect(result.internalError).toContain('aman doctor sandbox --fix');
  });

  test('unreachable slots fail the call with the repair command and no host fallback', async () => {
    const driver = new SlotDriver({
      socketPaths: [join(workDir, 'missing.sock')],
      logger: makeSilentLogger(),
      now: undefined,
      sleepMs: () => Promise.resolve(),
    });
    const result = await driver.run(await params());
    expect(result.terminatedBy).toBe('internal');
    expect(result.internalError).toContain('aman doctor sandbox --fix');
  });

  test('cancelling the call aborts the request and reports killed', async () => {
    const slow: FakeHandler = () => ({ status: 200, body: runResponse(), delayMs: 5000 });
    const { driver } = await driverFor([slow]);
    const controller = new AbortController();
    const input = { ...(await params()), signal: controller.signal };
    const pending = driver.run(input);
    setTimeout(() => controller.abort(), 50);
    expect((await pending).terminatedBy).toBe('killed');
  });

  test('a malformed reply is an internal failure, never a success', async () => {
    const garbage: FakeHandler = () => ({ status: 200, body: { exit_code: 'zero' } });
    const { driver } = await driverFor([garbage]);
    const result = await driver.run(await params());
    expect(result.terminatedBy).toBe('internal');
  });
});

describe('SlotDriver disk mode', () => {
  const agents: FakeAgent[] = [];
  afterEach(async () => {
    await Promise.all(agents.splice(0).map(agent => agent.stop()));
  });

  async function readyWith(diskMode: 'hard' | 'vm' | 'none'): Promise<string[]> {
    const logger = makeSilentLogger();
    const warn = jest.spyOn(logger, 'warn');
    const agent = new FakeAgent(() => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation({ diskMode, workspaceBytes: 1024 }) },
    }));
    agents.push(agent);
    const driver = new SlotDriver({
      socketPaths: [await agent.start()],
      logger,
      now: undefined,
      sleepMs: undefined,
    });
    await driver.ensureReady();
    await driver.ensureReady();
    return warn.mock.calls.map(call => String(call[0]));
  }

  test('warns once about a slot with no disk limit of its own, and not about a limited or VM-bounded one', async () => {
    expect(await readyWith('none')).toEqual(['sandbox slot has no disk limit of its own']);
    expect(await readyWith('hard')).toEqual([]);
    expect(await readyWith('vm')).toEqual([]);
  });
});
