import { resolveOnPinnedPath } from '../permissions/shellAllowlist';
import { ENV_BINARY } from './hostAuthenticatedGit';
import { shellEscape } from './provider/Provider';

const PLAIN_SHELL_WORD = /^[A-Za-z0-9_@%+=:,.-]+$/u;

/** Quotes a word only when the shell would otherwise split or expand it. */
export function shellWord(word: string): string {
  return PLAIN_SHELL_WORD.test(word) ? word : shellEscape(word);
}

/**
 * A host-run program executes as its resolved absolute path under the pinned PATH, never by a bare
 * name: the sandbox PATH can lead with model-writable directories, so a bare name could resolve to
 * a planted program. A name the host cannot resolve still runs under the pinned PATH only.
 */
export function pinnedProgramCommand(input: { argv: readonly string[]; pinnedPath: string }): string {
  const [program, ...rest] = input.argv;
  if (program === undefined) {
    throw new Error('A pinned program needs a program name');
  }
  return [ENV_BINARY, `PATH=${input.pinnedPath}`, resolveOnPinnedPath(program, input.pinnedPath) ?? program, ...rest]
    .map(shellWord)
    .join(' ');
}
