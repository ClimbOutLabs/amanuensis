import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import {
  resolveCodeModeSocketParent,
  resolveTrueForgeApiKey,
} from '../../../src/config';
import {
  prepareCodeModeSocketParent,
  removeCodeModeSocketParent,
} from '../../../src/sandbox/localLifecycle';

const logger = createLogger();

describe('per-port Code Mode socket folders', () => {
  it('gives a distinct folder per port', () => {
    const folders = [48711, 48712, 48713].map(port =>
      resolveCodeModeSocketParent({ port }),
    );
    expect(new Set(folders).size).toBe(3);
    expect(folders[0]).toContain('tf_cms_48711');
    expect(folders[1]).toContain('tf_cms_48712');
    expect(folders[2]).toContain('tf_cms_48713');
  });

  it('removing one instance folder leaves the others in place', async () => {
    const folders = [48721, 48722, 48723].map(port =>
      resolveCodeModeSocketParent({ port }),
    );
    try {
      for (const folder of folders) {
        await prepareCodeModeSocketParent({ path: folder, logger });
      }
      await removeCodeModeSocketParent(folders[0]);
      expect(existsSync(folders[0])).toBe(false);
      expect(existsSync(folders[1])).toBe(true);
      expect(existsSync(folders[2])).toBe(true);
    } finally {
      for (const folder of folders) {
        await rm(folder, { recursive: true, force: true });
      }
    }
  });

  it('fails clearly when the realpath would exceed the socket byte budget', () => {
    const longTmp = join(tmpdir(), 'x'.repeat(80));
    const spy = jest.spyOn(fs, 'realpathSync').mockReturnValue(longTmp);
    try {
      expect(() => resolveCodeModeSocketParent({ port: 48731 })).toThrow(
        /too long after realpath/,
      );
    } finally {
      spy.mockRestore();
    }
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
    expect(() => resolveTrueForgeApiKey({ standalone: false })).toThrow(
      /TRUEFORGE_API_KEY/,
    );
  });
});
