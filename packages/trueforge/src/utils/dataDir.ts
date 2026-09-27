import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Extracts the errno-style `code` from a caught filesystem error, if any. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'unknown';
}

/**
 * Thrown when a configured storage directory cannot be created or written.
 * The message carries operator detail (env var, resolved path, `-v`
 * remediation) for logs and boot stderr; never show it verbatim on
 * user-facing surfaces — use USER_FACING_STORAGE_UNAVAILABLE_MESSAGE there.
 */
export class DataDirConfigurationError extends Error {
  /** Env var the directory value came from, named for the operator. */
  readonly envVar: string;
  /** Resolved absolute path that could not be created or written. */
  readonly dir: string;

  constructor(input: { envVar: string; dir: string; cause?: unknown }) {
    super(
      `${input.envVar}: data directory '${input.dir}' is not writable (${errorCode(input.cause)}). ` +
        `Set ${input.envVar} to a path this process can write, or mount a persistent ` +
        `Docker volume there (e.g. -v <volume>:/data/... -e ${input.envVar}=/data/...).`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'DataDirConfigurationError';
    this.envVar = input.envVar;
    this.dir = input.dir;
  }
}

/** True when the error is an unwritable-storage-directory configuration failure. */
export function isDataDirConfigurationError(error: unknown): error is DataDirConfigurationError {
  return error instanceof DataDirConfigurationError;
}

/**
 * The static sentence shown on user-facing surfaces (knowledge UI status
 * messages, memory provider health) when storage is misconfigured. Operator
 * detail stays in the thrown error and logs; end users get no paths and no
 * `-v` remediation instructions.
 */
export const USER_FACING_STORAGE_UNAVAILABLE_MESSAGE =
  'The server’s storage isn’t available right now. Check the server’s storage and try again.';

/**
 * Absolute paths already validated by this process. Boot validation and the
 * lazy per-request/per-write sites resolve the same configured values, so
 * re-probing every call would repeat a `mkdir` + `access` on each knowledge
 * query and memory write.
 */
const validatedDataDirs = new Set<string>();

/**
 * Ensures a configured data directory exists and is writable by this process,
 * returning its absolute path.
 *
 * Storage dirs resolve from env vars with cwd-relative defaults (`./data/...`).
 * In the production image the process runs as an unprivileged user whose cwd is
 * root-owned, so a lazy `mkdir` at first use dies with a bare `EACCES` deep in
 * a request handler — far from anything naming the misconfigured env var. This
 * converts that into a configuration-shaped error instead: it names the env
 * var, the resolved path, and the remediation.
 */
export async function ensureWritableDataDir(input: {
  /** Raw configured value; may be cwd-relative. */
  dir: string;
  /** Env var the value came from, named in any error. */
  envVar: string;
}): Promise<string> {
  const absolute = path.resolve(input.dir);
  if (validatedDataDirs.has(absolute)) {
    return absolute;
  }
  try {
    await mkdir(absolute, { recursive: true });
    // mkdir -p succeeds on an existing directory even when it is not writable,
    // so probe write access explicitly; otherwise the failure still surfaces
    // later as a bare EACCES on the first real write.
    await access(absolute, constants.W_OK);
  } catch (error) {
    throw new DataDirConfigurationError({ envVar: input.envVar, dir: absolute, cause: error });
  }
  validatedDataDirs.add(absolute);
  return absolute;
}
