import { release, totalmem } from 'node:os';

import type { Host, SystemKind } from './host.ts';

export class SystemHost implements Host {
  readonly kind: SystemKind;

  constructor(kind: SystemKind) {
    this.kind = kind;
  }

  memoryBytes(): number {
    return totalmem();
  }

  kernelRelease(): string {
    return release();
  }
}

export class DarwinHost extends SystemHost {
  constructor() {
    super('darwin');
  }
}

export class LinuxHost extends SystemHost {
  constructor() {
    super('linux');
  }
}
