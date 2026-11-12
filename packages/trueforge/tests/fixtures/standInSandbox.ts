import { FakeSandboxProvider } from './fakeSandboxProvider';

/** A sandbox that runs nothing for real; only whether it has a network matters to the tests that use it. */
export class StandInSandbox extends FakeSandboxProvider {
  constructor(readonly network: 'none' | undefined) {
    super(new Map());
  }
}
