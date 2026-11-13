import configuration from '../../../src/config';

describe('memory pre-recall gate config', () => {
  it('is on by default, so a greeting does not look up memories', () => {
    expect(configuration.MEMORY_PRERECALL_GATE_ENABLED).toBe(true);
  });
});
