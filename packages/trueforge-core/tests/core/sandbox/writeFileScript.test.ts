import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalWriteTarget } from '../../../src/core/permissions/trackedExecutables';
import { WRITE_FILE_SCRIPT } from '../../../src/core/sandbox/Sandbox';

// Runs the real write_file helper with python3, the way the sandbox runs it.
describe('write_file helper script', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'write-file-script-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runWrite(input: { path: string; cwdRelative?: string; content?: string }): {
    status: number | null;
    output: Record<string, unknown>;
    stderr: string;
  } {
    const scriptPath = join(root, 'write-file.py');
    const payloadPath = join(root, 'payload.json');
    writeFileSync(scriptPath, WRITE_FILE_SCRIPT);
    writeFileSync(
      payloadPath,
      JSON.stringify({
        workspace_cwd: workspace,
        cwd_relative: input.cwdRelative ?? '',
        path: input.path,
        content: input.content ?? 'x = 1\n',
      }),
    );
    const result = spawnSync('python3', ['-I', '-S', scriptPath, payloadPath], { encoding: 'utf-8' });
    return {
      status: result.status,
      output: JSON.parse(result.stdout) as Record<string, unknown>,
      stderr: result.stderr,
    };
  }

  it('creates the missing folders of a new file', () => {
    const result = runWrite({ path: 'ytmusic-mcp/ytmusic_mcp/__init__.py' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.output['created_directories']).toEqual(['ytmusic-mcp', 'ytmusic-mcp/ytmusic_mcp']);
    expect(readFileSync(join(workspace, 'ytmusic-mcp/ytmusic_mcp/__init__.py'), 'utf-8')).toBe('x = 1\n');
  });

  it('writes a second file into a folder an earlier write created', () => {
    runWrite({ path: 'pkg/mod/__init__.py' });
    const result = runWrite({ path: 'pkg/mod/models.py' });

    expect(result.status).toBe(0);
    expect(result.output['created_directories']).toEqual([]);
  });

  it('creates missing folders below a nested cwd', () => {
    mkdirSync(join(workspace, 'sub'));
    const result = runWrite({ cwdRelative: 'sub', path: 'deep/er/file.txt' });

    expect(result.status).toBe(0);
    expect(readFileSync(join(workspace, 'sub/deep/er/file.txt'), 'utf-8')).toBe('x = 1\n');
  });

  it('refuses, with a plain error, a path through a file', () => {
    writeFileSync(join(workspace, 'notes'), 'text');
    const result = runWrite({ path: 'notes/inner.txt' });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.output['error']).toContain('notes is a file or a link, not a folder');
  });

  it('refuses, with a plain error, a path through a link to a folder outside the workspace', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, 'escape'));
    const result = runWrite({ path: 'escape/inner.txt' });

    expect(result.status).toBe(1);
    expect(result.output['error']).toContain('escape is a file or a link, not a folder');
    expect(() => readFileSync(join(outside, 'inner.txt'))).toThrow();
  });

  it('still refuses to overwrite an existing file', () => {
    runWrite({ path: 'a.txt' });
    const result = runWrite({ path: 'a.txt', content: 'other' });

    expect(result.status).toBe(1);
    expect(result.output['error']).toContain('creation-only');
    expect(readFileSync(join(workspace, 'a.txt'), 'utf-8')).toBe('x = 1\n');
  });
});

describe('canonicalWriteTarget for a new file in new folders', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'write-target-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves through the nearest folder that exists', () => {
    expect(canonicalWriteTarget({ p: 'a/b/c.py', cwd: root })).toBe(join(root, 'a/b/c.py'));
  });

  it('is null under a dangling link, whose destination is unknown', () => {
    symlinkSync(join(root, 'gone'), join(root, 'link'));
    expect(canonicalWriteTarget({ p: 'link/b/c.py', cwd: root })).toBeNull();
  });

  it('resolves a link that exists to where it points', () => {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(canonicalWriteTarget({ p: 'link/new/c.py', cwd: root })).toBe(join(root, 'real/new/c.py'));
  });
});
