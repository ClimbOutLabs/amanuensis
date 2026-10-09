import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Boots the real server entry (`src/main.ts`) with PERSONA_KNOWLEDGE_DIR
 * pointed at an unwritable directory and asserts the fail-fast boot check:
 * non-zero exit and stderr naming the env var instead of a bare EACCES.
 */
describe('server boot storage check', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'boot-storage-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

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

      const packageDir = resolve(__dirname, '..', '..', '..');
      // node_modules/.bin/tsx is a shell wrapper; node must run the real CLI.
      const tsxCli = join(packageDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const entry = join(packageDir, 'src', 'main.ts');
      const envFile = join(packageDir, '.env.test');

      const child = spawn(process.execPath, ['--env-file', envFile, tsxCli, entry], {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: '--conditions=trueforge-dev',
          PERSONA_KNOWLEDGE_DIR: locked,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
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

      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toContain('Failed to start server');
      expect(combined).toContain('PERSONA_KNOWLEDGE_DIR');
    },
    120_000,
  );
});
