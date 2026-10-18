import configuration from '../../../src/config';
import { sandboxDisabledByInstaller } from '../../../src/sandbox/slotBackend';

describe('sandboxDisabledByInstaller', () => {
  const original = { ...configuration };
  afterEach(() => {
    Object.assign(configuration, original);
  });

  it.each([
    { INSTALLER_INSTANCE: 'main', SANDBOX_BACKEND: 'docker', SANDBOX_IMAGE: '', expected: true },
    { INSTALLER_INSTANCE: 'main', SANDBOX_BACKEND: 'docker', SANDBOX_IMAGE: ' ', expected: true },
    { INSTALLER_INSTANCE: '', SANDBOX_BACKEND: 'docker', SANDBOX_IMAGE: '', expected: false },
    { INSTALLER_INSTANCE: 'main', SANDBOX_BACKEND: 'slots', SANDBOX_IMAGE: '', expected: false },
    { INSTALLER_INSTANCE: 'main', SANDBOX_BACKEND: 'docker', SANDBOX_IMAGE: 'img@sha256:1', expected: false },
  ] as const)('is $expected for %j', ({ expected, ...settings }) => {
    Object.assign(configuration, settings);
    expect(sandboxDisabledByInstaller()).toBe(expected);
  });
});
