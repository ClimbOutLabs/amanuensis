import { DisabledDriver } from '../../../../src/core/sandbox/driver/sandboxDisabled';
import { sandboxDisabledFix, sandboxDisabledMessage } from '../../../../src/core/sandbox/driver/sandboxDisabledText';

describe('sandboxDisabledMessage', () => {
  it('names the instance in the install command', () => {
    expect(sandboxDisabledMessage({ instance: 'main' })).toBe(
      "Code execution is off for this instance. Aman was installed without the sandbox, so it can't run code or read PDFs. Run `./installer/install.sh --name main` again on the computer where Aman is installed to turn it on, then press Re-check.",
    );
  });

  it.each([undefined, ''])('falls back to "your instance" for %j', instance => {
    expect(sandboxDisabledFix({ instance })).toContain('--name your instance`');
  });

  it('never mentions images, signatures or Docker', () => {
    expect(sandboxDisabledMessage({ instance: 'main' })).not.toMatch(/docker|image|cosign|signed/i);
  });
});

describe('DisabledDriver', () => {
  it('reports itself disabled with the complete user-facing message', async () => {
    const readiness = await new DisabledDriver('main').ensureReady();
    expect(readiness).toEqual({
      ready: false,
      error_code: 'sandbox_disabled',
      error: sandboxDisabledMessage({ instance: 'main' }),
      verbatim: true,
    });
  });
});
