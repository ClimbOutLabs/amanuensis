export type SystemKind = 'windows' | 'darwin' | 'linux';

// The host side of the installer: what the installer needs to know about the
// computer it is running on. Later stages add the host jobs (shortcuts,
// scheduled work, trust) behind this same interface.
export interface Host {
  readonly kind: SystemKind;
  memoryBytes: () => number;
  // The kernel release (uname -r): the doctor's runtime check tells a
  // native Linux Docker from one inside WSL2 or Docker Desktop by it.
  kernelRelease: () => string;
}
