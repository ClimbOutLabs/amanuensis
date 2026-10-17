/**
 * What a person is told when a reader command run in the sandbox on their file fails. The reader's raw output
 * can quote text from the file, so it never goes in the message; callers log it instead.
 */

/** Exit code `timeout` returns when it stops a command. */
const TIMEOUT_EXIT_CODE = 124;
/** Exit code of a process the kernel killed for running out of memory (SIGKILL). */
const KILLED_EXIT_CODE = 137;

export function plainReaderFailure(input: { exitCode: number; output: string }): string {
  if (input.exitCode === TIMEOUT_EXIT_CODE) {
    return 'Reading this file took too long.';
  }
  if (input.exitCode === KILLED_EXIT_CODE || input.output.includes('MemoryError')) {
    return 'This file is too large to read.';
  }
  return "Aman couldn't read this file.";
}
