import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractExecutedFileOperand,
  InMemoryTrackedExecutableStore,
  isGitControlPath,
  isNewWriteTarget,
  isSandboxToolPath,
  skipWrapperPrefix,
  writeTargetTouchesGitControl,
} from '../../../src/core/permissions/trackedExecutables';

const SCOPE = {
  tenant_id: 't1',
  created_by: 'u1',
  conversation_id: 'conv-1',
  repository_id: 'r1',
  workspace_cwd: '/repo',
};

describe('InMemoryTrackedExecutableStore', () => {
  test('track, isTracked, and untrack round-trip', () => {
    const store = new InMemoryTrackedExecutableStore();
    const identity = '/repo/dist/tool';
    expect(store.isTracked({ scope: SCOPE, file_identity: identity })).toBe(false);
    store.track({ scope: SCOPE, file_identity: identity });
    expect(store.isTracked({ scope: SCOPE, file_identity: identity })).toBe(true);
    store.untrack({ scope: SCOPE, file_identity: identity });
    expect(store.isTracked({ scope: SCOPE, file_identity: identity })).toBe(false);
  });

  test('scopes are isolated', () => {
    const store = new InMemoryTrackedExecutableStore();
    const identity = '/repo/dist/tool';
    store.track({ scope: SCOPE, file_identity: identity });
    expect(store.isTracked({ scope: { ...SCOPE, repository_id: 'r2' }, file_identity: identity })).toBe(false);
  });

  test('a file Aman wrote in one conversation is not tracked in another', () => {
    const store = new InMemoryTrackedExecutableStore();
    const identity = '/repo/dist/tool';
    store.track({ scope: SCOPE, file_identity: identity });
    expect(store.isTracked({ scope: { ...SCOPE, conversation_id: 'conv-2' }, file_identity: identity })).toBe(false);
  });

  test('grants are keyed by conversation and purged per conversation', () => {
    const store = new InMemoryTrackedExecutableStore();
    const grant = {
      conversation_id: 'conv-1',
      file_identity: '/repo/dist/tool',
      content_hash: 'abc',
      argv_hash: 'def',
    };
    expect(store.hasGrant(grant)).toBe(false);
    store.recordGrant(grant);
    expect(store.hasGrant(grant)).toBe(true);
    expect(store.hasGrant({ ...grant, content_hash: 'changed' })).toBe(false);
    store.purgeConversationGrants({ conversation_id: 'conv-1' });
    expect(store.hasGrant(grant)).toBe(false);
  });
});

describe('extractExecutedFileOperand', () => {
  test('finds script operands for interpreters', () => {
    expect(extractExecutedFileOperand({ argv: ['node', 'dist/tool.js'] })).toBe('dist/tool.js');
    expect(extractExecutedFileOperand({ argv: ['python3', '-u', 'tool.py'] })).toBe('tool.py');
  });

  test('ignores flags and returns undefined for bare interpreters', () => {
    expect(extractExecutedFileOperand({ argv: ['node', '--version'] })).toBeUndefined();
    expect(extractExecutedFileOperand({ argv: ['ls', '-la'] })).toBeUndefined();
  });
});

describe('skipWrapperPrefix', () => {
  test('skips nice and env KEY=value prefixes', () => {
    expect(skipWrapperPrefix(['nice', '-n', '10', 'ls'])).toEqual(['ls']);
    expect(skipWrapperPrefix(['env', 'FOO=bar', 'ls'])).toEqual(['ls']);
    expect(skipWrapperPrefix(['FOO=bar', 'ls'])).toEqual(['FOO=bar', 'ls']);
    expect(skipWrapperPrefix(['ls', '-la'])).toEqual(['ls', '-la']);
  });
});

describe('isGitControlPath', () => {
  test.each([
    '.git/config',
    'sub/.git/hooks/pre-commit',
    '.GIT/config',
    '.git./config',
    'GIT~1/config',
    'GITMOD~1',
    'sub/gitatt~1',
    '.gitattributes',
    'a/b/.gitattributes',
    '.gitmodules',
    '.GitModules',
  ])('flags %s', p => {
    expect(isGitControlPath(p)).toBe(true);
  });

  test.each(['src/index.ts', '.gitignore', 'git/notes.md', 'a.git/x', '.github/workflows/ci.yml'])('allows %s', p => {
    expect(isGitControlPath(p)).toBe(false);
  });
});

describe('isSandboxToolPath', () => {
  test.each([
    '.venv/bin/flock',
    'mcp-client/x',
    'a/.VENV/lib/site-packages/zz.pth',
    '/ws/.venv/pyvenv.cfg',
    'mcp-client/',
  ])('flags %s', p => {
    expect(isSandboxToolPath(p)).toBe(true);
  });
  test.each(['bin/ls', 'src/venv/bin/x', 'mcp-client.md', 'docs/mcp-clients/a.md'])('allows %s', p => {
    expect(isSandboxToolPath(p)).toBe(false);
  });
});

describe('writeTargetTouchesGitControl', () => {
  test('follows a symlinked directory or file into .git', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sentinel-gitctl-'));
    try {
      mkdirSync(join(ws, '.git'));
      symlinkSync(join(ws, '.git'), join(ws, 'link'));
      writeFileSync(join(ws, '.git', 'config'), '');
      symlinkSync(join(ws, '.git', 'config'), join(ws, 'notes.txt'));
      symlinkSync(join(ws, 'missing-target'), join(ws, 'dangling.txt'));
      expect(writeTargetTouchesGitControl({ p: 'link/config', cwd: ws })).toBe(true);
      expect(writeTargetTouchesGitControl({ p: 'notes.txt', cwd: ws })).toBe(true);
      expect(writeTargetTouchesGitControl({ p: 'dangling.txt', cwd: ws })).toBe(true);
      expect(writeTargetTouchesGitControl({ p: 'plain.txt', cwd: ws })).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('isNewWriteTarget', () => {
  test('a path that does not exist yet is new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'new-target-'));
    try {
      expect(isNewWriteTarget({ p: 'fresh.py', cwd: dir })).toBe(true);
      expect(isNewWriteTarget({ p: 'sub/fresh.py', cwd: dir })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an existing file is not new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'new-target-'));
    try {
      writeFileSync(join(dir, 'README.md'), 'text');
      expect(isNewWriteTarget({ p: 'README.md', cwd: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dangling symlink is not new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'new-target-'));
    try {
      symlinkSync(join(dir, 'missing.txt'), join(dir, 'link.txt'));
      expect(isNewWriteTarget({ p: 'link.txt', cwd: dir })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a remote sandbox path is never new, because the server cannot see it', () => {
    expect(isNewWriteTarget({ p: 'fresh.py', cwd: '/workspace', resolution: 'remote' })).toBe(false);
  });
});
