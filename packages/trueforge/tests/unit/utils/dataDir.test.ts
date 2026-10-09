import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  DataDirConfigurationError,
  ensureWritableDataDir,
  isDataDirConfigurationError,
  USER_FACING_STORAGE_UNAVAILABLE_MESSAGE,
} from '../../../src/utils/dataDir';

describe('ensureWritableDataDir', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'data-dir-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a missing nested directory and returns its absolute path', async () => {
    const nested = join(root, 'a', 'b');
    const result = await ensureWritableDataDir({ dir: nested, envVar: 'TEST_DATA_DIR' });
    expect(result).toBe(resolve(nested));
  });

  it('succeeds idempotently on an existing writable directory', async () => {
    const first = await ensureWritableDataDir({ dir: root, envVar: 'TEST_DATA_DIR' });
    const second = await ensureWritableDataDir({ dir: root, envVar: 'TEST_DATA_DIR' });
    expect(first).toBe(second);
  });

  it('throws a configuration-shaped error naming the env var when unwritable', async () => {
    // A path under a regular file can never be created (ENOTDIR), portably.
    const file = join(root, 'file');
    await writeFile(file, 'x', 'utf8');
    const blocked = join(file, 'sub');

    const error: unknown = await ensureWritableDataDir({
      dir: blocked,
      envVar: 'PERSONA_KNOWLEDGE_DIR',
    }).then(
      () => null,
      caught => caught,
    );
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain('PERSONA_KNOWLEDGE_DIR');
      expect(error.message).toContain(resolve(blocked));
      expect(error.message).toContain('not writable');
      expect(error.cause).toBeDefined();
    }
  });

  it('resolves cwd-relative values to an absolute path', async () => {
    const nested = join(root, 'rel', 'dir');
    const relativeForm = relative(process.cwd(), nested);
    expect(isAbsolute(relativeForm)).toBe(false);
    const result = await ensureWritableDataDir({ dir: relativeForm, envVar: 'TEST_DATA_DIR' });
    expect(result).toBe(nested);
  });

  // Root bypasses access(2) permission checks, so the write probe can never
  // fail there: skip explicitly under root rather than asserting a false
  // negative. The probe itself is verified as a non-root uid in CI/dev.
  const itUnlessRoot = typeof process.geteuid === 'function' && process.geteuid() === 0 ? it.skip : it;

  itUnlessRoot('throws a configuration-shaped error for an existing-but-unwritable directory', async () => {
    // mkdir -p succeeds on an existing directory even when it is not writable,
    // so this permission-locked fixture is what the access(W_OK) probe exists for.
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o555);

    const error: unknown = await ensureWritableDataDir({
      dir: locked,
      envVar: 'PERSONA_KNOWLEDGE_DIR',
    }).then(
      () => null,
      caught => caught,
    );
    expect(error).toBeInstanceOf(DataDirConfigurationError);
    expect(isDataDirConfigurationError(error)).toBe(true);
    if (error instanceof Error) {
      expect(error.message).toContain('PERSONA_KNOWLEDGE_DIR');
      expect(error.message).toContain(resolve(locked));
      expect(error.message).toContain('not writable');
      expect(error.cause).toBeDefined();
    }
    if (error instanceof DataDirConfigurationError) {
      expect(error.envVar).toBe('PERSONA_KNOWLEDGE_DIR');
      expect(error.dir).toBe(resolve(locked));
    }
  });

  it('keeps operator detail out of the user-facing storage message', () => {
    expect(USER_FACING_STORAGE_UNAVAILABLE_MESSAGE).not.toContain('PERSONA_KNOWLEDGE_DIR');
    expect(USER_FACING_STORAGE_UNAVAILABLE_MESSAGE).not.toContain('-v');
  });

  it('does not re-probe a path it already validated', async () => {
    const nested = join(root, 'memo', 'dir');
    const first = await ensureWritableDataDir({ dir: nested, envVar: 'TEST_DATA_DIR' });
    await chmod(nested, 0o555);
    try {
      // Still resolves from the memoized validation instead of throwing.
      const second = await ensureWritableDataDir({ dir: nested, envVar: 'TEST_DATA_DIR' });
      expect(second).toBe(first);
    } finally {
      await chmod(nested, 0o755);
    }
  });
});
