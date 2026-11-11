describe('MEMORY_NIGHTLY_JOB', () => {
  const saved = process.env['MEMORY_NIGHTLY_JOB'];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env['MEMORY_NIGHTLY_JOB'];
    } else {
      process.env['MEMORY_NIGHTLY_JOB'] = saved;
    }
    jest.resetModules();
  });

  async function load(value: string | undefined) {
    if (value === undefined) {
      delete process.env['MEMORY_NIGHTLY_JOB'];
    } else {
      process.env['MEMORY_NIGHTLY_JOB'] = value;
    }
    jest.resetModules();
    return (await import('../../../src/config')).default.MEMORY_NIGHTLY_JOB;
  }

  it('is off while tests run, so no test starts the job', () => {
    expect(saved).toBe('false');
  });

  it('defaults to off', async () => {
    expect(await load(undefined)).toBe(false);
  });

  it('turns on with true', async () => {
    expect(await load('true')).toBe(true);
  });
});
