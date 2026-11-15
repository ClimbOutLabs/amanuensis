describe('MEMORY_PAGE_SORTING', () => {
  const saved = process.env['MEMORY_PAGE_SORTING'];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env['MEMORY_PAGE_SORTING'];
    } else {
      process.env['MEMORY_PAGE_SORTING'] = saved;
    }
    jest.resetModules();
  });

  async function load(value: string | undefined) {
    if (value === undefined) {
      delete process.env['MEMORY_PAGE_SORTING'];
    } else {
      process.env['MEMORY_PAGE_SORTING'] = value;
    }
    jest.resetModules();
    return (await import('../../../src/config')).default.MEMORY_PAGE_SORTING;
  }

  it('defaults to on', async () => {
    expect(await load(undefined)).toBe('on');
  });

  it('follows the environment value', async () => {
    expect(await load('report')).toBe('report');
    expect(await load('off')).toBe('off');
  });
});
