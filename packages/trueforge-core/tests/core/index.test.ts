import * as core from '../../src/core';

describe('core index', () => {
  it('leaves the run_code setup failure contract to its schema module, which the UI imports directly', () => {
    expect(core).not.toHaveProperty('RUN_CODE_SETUP_ERROR_CODES');
    expect(core).not.toHaveProperty('RunCodeSetupFailureSchema');
  });
});
