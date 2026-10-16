import { checkDemo } from '../../../../../src/cli/doctor/checks/demo';
import { fakeDeps } from '../fakeDeps';

describe('demo check', () => {
  it('is ok and says demo mode is on when DEMO_MODE is true', () => {
    const check = checkDemo({ deps: fakeDeps({ env: { DEMO_MODE: ' True ' } }) });
    expect(check.state).toBe('ok');
    expect(check.detail).toContain('Demo mode is on');
  });

  it('is off and says demo mode is off when DEMO_MODE is false or unset', () => {
    for (const env of [{ DEMO_MODE: 'false' }, {}]) {
      const check = checkDemo({ deps: fakeDeps({ env }) });
      expect(check.state).toBe('off');
      expect(check.detail).toContain('Demo mode is off');
    }
  });
});
