import { checkAttachments, checkRunCode } from '../../../../../src/cli/doctor/checks/sandbox';

describe('sandbox-backed features', () => {
  it('reports run_code as off with the reason', () => {
    const check = checkRunCode();
    expect(check).toMatchObject({ id: 'run_code', state: 'off' });
    expect(check.detail).toContain('run_code is not available');
  });

  it('reports attachments as off with the reason', () => {
    const check = checkAttachments();
    expect(check).toMatchObject({ id: 'attachments', state: 'off' });
    expect(check.detail).toContain('attachments');
    expect(check.detail).toContain('sandbox');
  });
});
