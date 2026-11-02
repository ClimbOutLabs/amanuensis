import type { Host, SystemKind } from './host.ts';
import { DarwinHost, LinuxHost } from './systemHosts.ts';

export function hostForKind(kind: SystemKind): Host {
  if (kind === 'darwin') {
    return new DarwinHost();
  }
  return new LinuxHost();
}

// Node names the systems darwin and linux; anything else is treated as
// linux, which is the family the installer supports. Windows is reached
// through WSL2, which Node reports as linux.
export function hostForPlatform(platform: string): Host {
  if (platform === 'darwin') {
    return new DarwinHost();
  }
  return new LinuxHost();
}
