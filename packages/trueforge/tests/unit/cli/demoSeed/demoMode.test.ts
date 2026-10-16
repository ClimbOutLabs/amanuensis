describe('DEMO_MODE guard', () => {
  const original = process.env['DEMO_MODE'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['DEMO_MODE'];
    } else {
      process.env['DEMO_MODE'] = original;
    }
    jest.resetModules();
  });

  async function enabledWith(value: string | undefined): Promise<boolean> {
    jest.resetModules();
    if (value === undefined) {
      delete process.env['DEMO_MODE'];
    } else {
      process.env['DEMO_MODE'] = value;
    }
    const { isDemoModeEnabled } = await import('../../../../src/cli/demoSeed/runtime');
    return isDemoModeEnabled();
  }

  it('is off unless the instance opts in', async () => {
    expect(await enabledWith(undefined)).toBe(false);
    expect(await enabledWith('false')).toBe(false);
  });

  it('is on only for DEMO_MODE=true, read through the server config', async () => {
    expect(await enabledWith('true')).toBe(true);
  });

  it('rejects a malformed value instead of guessing', async () => {
    await expect(enabledWith('yes')).rejects.toThrow('DEMO_MODE must be "true" or "false"');
  });
});
