import * as fs from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import { resolveCodeModeSocketParent, resolveTrueForgeApiKey } from '../../../src/config';
import { prepareCodeModeSocketParent, removeCodeModeSocketParent } from '../../../src/sandbox/localLifecycle';

const logger = createLogger();

describe('per-port Code Mode socket folders', () => {
  it('gives a distinct folder per port', () => {
    const folders = [48711, 48712, 48713].map(port => resolveCodeModeSocketParent({ port }));
    expect(new Set(folders).size).toBe(3);
    expect(folders[0]).toContain('tf_cms_48711');
    expect(folders[1]).toContain('tf_cms_48712');
    expect(folders[2]).toContain('tf_cms_48713');
  });

  it('removing one instance folder leaves the others in place', async () => {
    const folderA = resolveCodeModeSocketParent({ port: 48721 });
    const folderB = resolveCodeModeSocketParent({ port: 48722 });
    const folderC = resolveCodeModeSocketParent({ port: 48723 });
    const folders = [folderA, folderB, folderC];
    try {
      for (const folder of folders) {
        await prepareCodeModeSocketParent({ path: folder, logger });
      }
      await removeCodeModeSocketParent(folderA);
      expect(fs.existsSync(folderA)).toBe(false);
      expect(fs.existsSync(folderB)).toBe(true);
      expect(fs.existsSync(folderC)).toBe(true);
    } finally {
      for (const folder of folders) {
        await rm(folder, { recursive: true, force: true });
      }
    }
  });

  it('refuses to remove a socket folder when its port is in use', async () => {
    const port = 48729;
    const folder = resolveCodeModeSocketParent({ port });
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(port, '127.0.0.1', resolve));
    try {
      await prepareCodeModeSocketParent({ path: folder, logger, port });
      expect(fs.existsSync(folder)).toBe(true);
      await expect(prepareCodeModeSocketParent({ path: folder, logger, port })).rejects.toThrow(/in use/);
      expect(fs.existsSync(folder)).toBe(true);
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('fails clearly when the realpath would exceed the socket byte budget', () => {
    const longTmp = join(tmpdir(), 'x'.repeat(80));
    expect(() => resolveCodeModeSocketParent({ port: 48731, realpathFn: () => longTmp })).toThrow(
      /too long after realpath/,
    );
  });
});

describe('standalone scheduler key', () => {
  const ENV_KEY = 'TRUEFORGE_API_KEY';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
  });

  it('generates a different key on each resolve when the env var is unset', () => {
    const first = resolveTrueForgeApiKey({ standalone: true });
    const second = resolveTrueForgeApiKey({ standalone: true });
    expect(first).not.toBe('');
    expect(second).not.toBe('');
    expect(first).not.toBe(second);
    expect(first).toHaveLength(64);
  });

  it('honors the env override', () => {
    process.env[ENV_KEY] = 'pinned-test-key';
    expect(resolveTrueForgeApiKey({ standalone: true })).toBe('pinned-test-key');
    expect(resolveTrueForgeApiKey({ standalone: false })).toBe('pinned-test-key');
  });

  it('treats an empty env var as unset in standalone', () => {
    process.env[ENV_KEY] = '';
    const key = resolveTrueForgeApiKey({ standalone: true });
    expect(key).not.toBe('');
    expect(key).toHaveLength(64);
  });

  it('throws for distributed mode when the env var is unset', () => {
    expect(() => resolveTrueForgeApiKey({ standalone: false })).toThrow(/TRUEFORGE_API_KEY/);
  });

  it.each(['dev-only-placeholder', 'placeholder-value-please-generate-your-own'])(
    'refuses placeholder key %s in standalone mode',
    placeholder => {
      process.env[ENV_KEY] = placeholder;
      expect(() => resolveTrueForgeApiKey({ standalone: true })).toThrow(/placeholder/);
    },
  );

  it.each(['dev-only-placeholder', 'placeholder-value-please-generate-your-own'])(
    'accepts placeholder key %s in distributed mode so the Helm default still starts',
    placeholder => {
      process.env[ENV_KEY] = placeholder;
      expect(resolveTrueForgeApiKey({ standalone: false })).toBe(placeholder);
    },
  );
});
