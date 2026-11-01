/**
 * What a person is told when a reader command run in the sandbox on their file fails. The reader's raw output
 * can quote text from the file, so it never goes in the message; callers log it instead.
 */

import { UNREADABLE_MESSAGE } from '../../documents/documentText';

/** Exit code `timeout` returns when it stops a command. */
const TIMEOUT_EXIT_CODE = 124;
/** Exit code of a process the kernel killed for running out of memory (SIGKILL). */
const KILLED_EXIT_CODE = 137;

export function plainReaderFailure(input: { exitCode: number; output: string }): string {
  if (input.exitCode === TIMEOUT_EXIT_CODE) {
    return 'Reading this file took too long. Try again; if it happens again, send a smaller file or only the part you need.';
  }
  if (input.exitCode === KILLED_EXIT_CODE || input.output.includes('MemoryError')) {
    return 'This file is too large to read. Send a smaller file or only the part you need.';
  }
  return UNREADABLE_MESSAGE;
}
