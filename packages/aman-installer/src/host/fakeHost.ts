import type { Host, SystemKind } from './host.ts';

// A host for tests: the kind, the memory and the kernel release are set by
// the test, and nothing on the real computer is touched.
export class FakeHost implements Host {
  readonly kind: SystemKind;
  private readonly memory: number;
  private readonly kernel: string;

  constructor(options: { kind: SystemKind; memoryBytes: number; kernelRelease?: string }) {
    this.kind = options.kind;
    this.memory = options.memoryBytes;
    this.kernel = options.kernelRelease ?? '';
  }

  memoryBytes(): number {
    return this.memory;
  }

  kernelRelease(): string {
    return this.kernel;
  }
}
