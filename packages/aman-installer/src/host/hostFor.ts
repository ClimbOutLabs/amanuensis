import type { Host, SystemKind } from './host.ts';
import { DarwinHost, LinuxHost, WindowsHost } from './systemHosts.ts';

export function hostForKind(kind: SystemKind): Host {
  if (kind === 'windows') {
    return new WindowsHost();
  }
  if (kind === 'darwin') {
    return new DarwinHost();
  }
  return new LinuxHost();
}

// Node names the systems win32, darwin and linux; anything else is treated
// as linux, which is the family the installer supports.
export function hostForPlatform(platform: string): Host {
  if (platform === 'win32') {
    return new WindowsHost();
  }
  if (platform === 'darwin') {
    return new DarwinHost();
  }
  return new LinuxHost();
}
