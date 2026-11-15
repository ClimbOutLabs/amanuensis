import { existsSync } from 'node:fs';

/**
 * Whether the real programs a suite drives are on this machine. A developer's machine without them
 * skips the suite. CI must have them, so there a missing one fails the run instead of hiding it.
 */
export function hostToolsPresent(tools: readonly string[]): boolean {
  const missing = tools.filter(tool => !existsSync(tool));
  if (missing.length === 0) {
    return true;
  }
  const ci = process.env['CI'];
  if (ci !== undefined && ci !== '' && ci !== 'false') {
    throw new Error(
      `These tests need ${missing.join(', ')}, which this CI machine does not have. Install it in the CI job that runs the trueforge-core tests.`,
    );
  }
  return false;
}
