import type { Host, SystemKind } from './host.ts';

// A host for tests: the kind and the memory are set by the test, and nothing
// on the real computer is touched.
export class FakeHost implements Host {
  readonly kind: SystemKind;
  private readonly memory: number;

  constructor(options: { kind: SystemKind; memoryBytes: number }) {
    this.kind = options.kind;
    this.memory = options.memoryBytes;
  }

  memoryBytes(): number {
    return this.memory;
  }
}
