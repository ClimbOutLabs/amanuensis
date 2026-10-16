import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Boots the real server entry (`src/main.ts`) with a storage directory it
 * cannot use and asserts the fail-fast boot check: non-zero exit and output
 * naming the env var instead of a bare EACCES/ENOTDIR.
 */
// Standalone refuses to boot without login, and that gate runs before the storage check under test.
const BOOT_OIDC_ENV = {
  OIDC_ISSUER_URL: 'http://127.0.0.1:1/dex',
  OIDC_CLIENT_ID: 'boot-storage-test',
  OIDC_CLIENT_SECRET: 'boot-storage-test-secret',
};

describe('server boot storage check', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'boot-storage-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function bootServer(env: Record<string, string>): Promise<{ exitCode: number | null; output: string }> {
    const packageDir = resolve(__dirname, '..', '..', '..');
    // node_modules/.bin/tsx is a shell wrapper; node must run the real CLI.
    const tsxCli = join(packageDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const entry = join(packageDir, 'src', 'main.ts');
    const envFile = join(packageDir, '.env.test');

    const child = spawn(process.execPath, ['--env-file', envFile, tsxCli, entry], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '--conditions=trueforge-dev', ...BOOT_OIDC_ENV, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr.on('data', chunk => {
      output += String(chunk);
    });
    const exitCode: number | null = await new Promise(resolveExit => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveExit(null);
      }, 90_000);
      child.on('exit', code => {
        clearTimeout(timer);
        resolveExit(code);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolveExit(null);
      });
    });
    return { exitCode, output };
  }

  /** A regular file where a directory is expected: unusable even for root. */
  async function pathUnderFile(name: string): Promise<string> {
    const blocker = join(root, 'not-a-directory');
    await writeFile(blocker, 'synthetic blocker');
    return join(blocker, name);
  }

  // Root bypasses access(2) permission checks, so the boot check would pass
  // and the server would keep booting: skip explicitly under root rather
  // than asserting a false negative. The probe itself is verified as a
  // non-root uid in CI/dev.
  const itUnlessRoot = typeof process.geteuid === 'function' && process.geteuid() === 0 ? it.skip : it;

  itUnlessRoot(
    'refuses to start when PERSONA_KNOWLEDGE_DIR is unwritable',
    async () => {
      const locked = join(root, 'persona-knowledge');
      await mkdir(locked);
      await chmod(locked, 0o555);

      const { exitCode, output } = await bootServer({ PERSONA_KNOWLEDGE_DIR: locked });

      expect(exitCode).toBe(1);
      expect(output).toContain('Failed to start server');
      expect(output).toContain('PERSONA_KNOWLEDGE_DIR');
    },
    120_000,
  );

  it('refuses to start when PERSONA_KNOWLEDGE_DIR cannot be created', async () => {
    const { exitCode, output } = await bootServer({ PERSONA_KNOWLEDGE_DIR: await pathUnderFile('persona-knowledge') });

    expect(exitCode).toBe(1);
    expect(output).toContain('Failed to start server');
    expect(output).toContain('PERSONA_KNOWLEDGE_DIR');
  }, 120_000);

  it('refuses to start when the markdown memory directory cannot be created', async () => {
    const { exitCode, output } = await bootServer({
      PERSONA_KNOWLEDGE_DIR: join(root, 'persona-knowledge'),
      MEMORY_BACKEND: 'markdown',
      MEMORY_MARKDOWN_DIR: await pathUnderFile('memory'),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain('Failed to start server');
    expect(output).toContain('MEMORY_MARKDOWN_DIR');
  }, 120_000);
});
