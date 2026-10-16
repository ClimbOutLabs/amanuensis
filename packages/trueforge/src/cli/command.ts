import type { CliIo } from './io';

/** A CLI command returns its exit code: 0 ok, 1 failure. Usage errors are thrown as `UsageError` (exit 2). */
export type Command = (context: { args: readonly string[]; io: CliIo }) => Promise<number>;
