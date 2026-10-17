import { DisabledDriver } from '../../../../src/core/sandbox/driver/sandboxDisabled';
import { SANDBOX_DISABLED_MESSAGE } from '../../../../src/core/sandbox/driver/sandboxDisabledText';

describe('SANDBOX_DISABLED_MESSAGE', () => {
  it('points at the doctor command, not the installer script', () => {
    expect(SANDBOX_DISABLED_MESSAGE).toBe(
      "Code execution is off for this instance. Aman was installed without the sandbox, so it can't run code or read PDFs. Run `aman doctor sandbox --fix` on the computer where Aman is installed.",
    );
    expect(SANDBOX_DISABLED_MESSAGE).not.toMatch(/install\.sh|your instance|Re-check/);
  });

  it('never mentions images, signatures or Docker', () => {
    expect(SANDBOX_DISABLED_MESSAGE).not.toMatch(/docker|image|cosign|signed/i);
  });
});

describe('DisabledDriver', () => {
  it('reports itself disabled with the complete user-facing message', async () => {
    const readiness = await new DisabledDriver().ensureReady();
    expect(readiness).toEqual({
      ready: false,
      error_code: 'sandbox_disabled',
      error: SANDBOX_DISABLED_MESSAGE,
      verbatim: true,
    });
  });
});
