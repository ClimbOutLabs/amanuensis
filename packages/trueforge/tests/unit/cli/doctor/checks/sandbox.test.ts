import { checkAttachments, checkRunCode } from '../../../../../src/cli/doctor/checks/sandbox';
import { fakeDeps } from '../fakeDeps';

const SLOT_ENV = { SANDBOX_BACKEND: 'slots', SANDBOX_SLOTS: '4', SANDBOX_SLOTS_DIR: '/run/aman-slots' };

describe('run_code', () => {
  it('is off, with the reason, when the instance has no sandbox', async () => {
    const check = await checkRunCode({ deps: fakeDeps({ env: {} }), timeoutMs: 1000 });
    expect(check).toMatchObject({ id: 'run_code', state: 'off' });
    expect(check.detail).toContain('installed without the sandbox');
  });

  it('asks the slots by their control sockets, the way the app does, and is ok when they are ready', async () => {
    const asked: string[][] = [];
    const deps = fakeDeps({
      env: SLOT_ENV,
      slotsReadiness: ({ socketPaths }) => {
        asked.push(socketPaths);
        return Promise.resolve({ ready: true });
      },
    });
    const check = await checkRunCode({ deps, timeoutMs: 1000 });
    expect(check).toMatchObject({ id: 'run_code', state: 'ok' });
    expect(asked).toEqual([
      [
        '/run/aman-slots/1/agent.sock',
        '/run/aman-slots/2/agent.sock',
        '/run/aman-slots/3/agent.sock',
        '/run/aman-slots/4/agent.sock',
      ],
    ]);
  });

  it('fails with the sandbox repair command when no slot is usable', async () => {
    const deps = fakeDeps({
      env: SLOT_ENV,
      slotsReadiness: () =>
        Promise.resolve({
          ready: false,
          error_code: 'slots_unavailable',
          error: 'The sandbox slots are not running.',
        }),
    });
    const check = await checkRunCode({ deps, timeoutMs: 1000 });
    expect(check).toMatchObject({ state: 'fail', detail: 'The sandbox slots are not running.' });
    expect(check.fix).toContain('aman doctor sandbox --fix');
  });

  it('fails with a plain reason when asking throws', async () => {
    const deps = fakeDeps({ env: SLOT_ENV, slotsReadiness: () => Promise.reject(new Error('boom')) });
    const check = await checkRunCode({ deps, timeoutMs: 1000 });
    expect(check.state).toBe('fail');
    expect(check.detail).not.toContain('boom');
    expect(check.fix).toContain('aman doctor sandbox --fix');
  });

  it('fails when the sandbox settings are incomplete', async () => {
    const deps = fakeDeps({ env: { SANDBOX_BACKEND: 'slots' } });
    const check = await checkRunCode({ deps, timeoutMs: 1000 });
    expect(check.state).toBe('fail');
    expect(check.fix).toContain('install.sh');
  });
});

describe('attachments', () => {
  it('reports attachments as off with the reason', () => {
    const check = checkAttachments();
    expect(check).toMatchObject({ id: 'attachments', state: 'off' });
    expect(check.detail).toContain('attachments');
    expect(check.detail).toContain('sandbox');
  });
});
