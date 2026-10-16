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
    expect(check.fix).toBe('Run aman doctor sandbox --fix');
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
    expect(check.fix).toBe('Run aman doctor sandbox --fix');
  });
});

describe('attachments', () => {
  const ready = () => Promise.resolve({ state: 'ready' } as const);

  it('is off, with the reason, when the instance has no sandbox', async () => {
    const check = await checkAttachments({ deps: fakeDeps({ env: {} }), timeoutMs: 1000 });
    expect(check).toMatchObject({ id: 'attachments', state: 'off' });
    expect(check.detail).toContain('installed without the sandbox');
  });

  it('is ok in plain words when a file sent into the sandbox comes back and the sandbox can read PDFs and images', async () => {
    const asked: { socketPaths: string[]; treeDiskMb: number; ocrLanguages: string[] }[] = [];
    const deps = fakeDeps({
      env: { ...SLOT_ENV, SANDBOX_SESSION_DISK_MB: '4096', DOCUMENT_OCR_LANGUAGES: 'eng deu' },
      slotsAttachments: ({ socketPaths, treeDiskMb, ocrLanguages }) => {
        asked.push({ socketPaths, treeDiskMb, ocrLanguages });
        return ready();
      },
    });
    const check = await checkAttachments({ deps, timeoutMs: 1000 });
    expect(check).toEqual({
      id: 'attachments',
      state: 'ok',
      detail: 'Reading attachments is ready: PDFs, images and email attachments can be read.',
      fix: '',
    });
    expect(asked[0]?.socketPaths).toHaveLength(4);
    expect(asked[0]?.socketPaths[0]).toBe('/run/aman-slots/1/agent.sock');
    // The probe runs with the instance's real quota and OCR languages.
    expect(asked[0]?.treeDiskMb).toBe(4096);
    // The configured language, plus every language a page may be read with and script detection.
    expect(asked[0]?.ocrLanguages).toEqual(
      expect.arrayContaining(['deu', 'eng', 'hin', 'mar', 'ara', 'chi_sim', 'jpn', 'kor', 'rus', 'osd']),
    );
  });

  it('uses the default quota and the Latin default languages, plus the other scripts, when the instance sets none', async () => {
    let seen: { treeDiskMb: number; ocrLanguages: string[] } | undefined;
    const deps = fakeDeps({
      env: SLOT_ENV,
      slotsAttachments: ({ treeDiskMb, ocrLanguages }) => {
        seen = { treeDiskMb, ocrLanguages };
        return ready();
      },
    });
    await checkAttachments({ deps, timeoutMs: 1000 });
    expect(seen?.treeDiskMb).toBe(2048);
    expect(seen?.ocrLanguages).toEqual(
      expect.arrayContaining(['eng', 'por', 'spa', 'fra', 'deu', 'ita', 'nld', 'osd']),
    );
  });

  it.each([
    ['tools_missing', 'This sandbox cannot read PDFs and images yet.'],
    ['sandbox_unavailable', 'The sandbox is not running, so attachments cannot be read.'],
    ['file_not_sent', 'A test file could not be sent into the sandbox.'],
    ['file_changed', 'A test file came back from the sandbox changed.'],
  ] as const)(
    'fails with one plain sentence and the repair command when the problem is %s',
    async (problem, detail) => {
      const deps = fakeDeps({
        env: SLOT_ENV,
        slotsAttachments: () => Promise.resolve({ state: 'not_ready', problem }),
      });
      const check = await checkAttachments({ deps, timeoutMs: 1000 });
      expect(check).toEqual({ id: 'attachments', state: 'fail', detail, fix: 'Run aman doctor sandbox --fix' });
    },
  );

  it('only warns, so it cannot stop an upgrade, when the sandbox is busy', async () => {
    const deps = fakeDeps({ env: SLOT_ENV, slotsAttachments: () => Promise.resolve({ state: 'busy' }) });
    const check = await checkAttachments({ deps, timeoutMs: 1000 });
    expect(check.state).toBe('warn');
    expect(check.detail).toBe('The sandbox was busy, so reading attachments could not be checked.');
    expect(check.fix).not.toBe('');
  });

  it('fails with a plain reason when the probe throws', async () => {
    const deps = fakeDeps({ env: SLOT_ENV, slotsAttachments: () => Promise.reject(new Error('boom')) });
    const check = await checkAttachments({ deps, timeoutMs: 1000 });
    expect(check.state).toBe('fail');
    expect(check.detail).not.toContain('boom');
    expect(check.fix).toContain('aman doctor sandbox --fix');
  });

  it('fails when the sandbox settings are incomplete', async () => {
    const check = await checkAttachments({ deps: fakeDeps({ env: { SANDBOX_BACKEND: 'slots' } }), timeoutMs: 1000 });
    expect(check.state).toBe('fail');
    expect(check.detail).toBe('The sandbox settings for this instance are incomplete.');
    expect(check.fix).toBe('Run aman doctor sandbox --fix');
  });
});
