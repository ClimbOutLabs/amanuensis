import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { type PathResolution } from '../../../src/core/permissions/trackedExecutables';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/**
 * A read names a file by its full path as readily as by a relative one; a skill's instructions are offered to the
 * model at a full path such as `/workspace/.aman/skills/<name>/SKILL.md`. The full path is judged by where it lands,
 * exactly like the relative spelling of the same file.
 */

const REMOTE_ROOT = '/workspace';
const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });

function ctxFor(root: string, resolution: PathResolution | undefined): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: root,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    path_resolution: resolution,
  };
}

function exec(command: string): SentinelAction {
  return { tool_name: 'exec', canonical_params: { command }, tool_type: 'truefoundry-system', mcp_hints: {} };
}

async function tierOf(command: string, root: string, resolution: PathResolution | undefined): Promise<number> {
  return (await classifyTier(exec(command), ctxFor(root, resolution))).tier;
}

describe('a read by full path inside a remote sandbox workspace', () => {
  test.each([
    'cat /workspace/.aman/skills/find-skills/SKILL.md',
    'cat -n /workspace/notes.md',
    'head -50 /workspace/.aman/skills/find-skills/SKILL.md',
    "sed -n '1,40p' /workspace/.aman/skills/find-skills/SKILL.md",
    'ls -la /workspace/.aman/skills/find-skills',
    'grep -n name /workspace/.aman/skills/find-skills/SKILL.md',
    'cd /workspace/.aman/skills/find-skills && cat SKILL.md',
    'cd /workspace && cat /workspace/.aman/skills/find-skills/SKILL.md',
  ])('runs without a card: %s', async command => {
    expect(await tierOf(command, REMOTE_ROOT, 'remote')).toBe(1);
  });

  test.each([
    'cat /etc/passwd',
    'cat /workspace-evil/notes.md',
    'cat /workspace/../etc/passwd',
    'cat /',
    'ls /',
    'cat /workspace/notes.md /etc/passwd',
    'cd /workspace && cat /etc/passwd',
    'grep -rn root /etc',
  ])('still asks when the path is outside the workspace: %s', async command => {
    expect(await tierOf(command, REMOTE_ROOT, 'remote')).toBe(3);
  });
});

describe('a read by full path on a host workspace', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'full-path-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'full-path-out-'));
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# demo\n');
    writeFileSync(join(outside, 'secret.txt'), 'x\n');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('a file inside the workspace runs without a card, the same as its relative spelling', async () => {
    expect(await tierOf(`cat ${join(root, 'skills', 'demo', 'SKILL.md')}`, root, undefined)).toBe(1);
    expect(await tierOf('cat skills/demo/SKILL.md', root, undefined)).toBe(1);
  });

  test('a file outside, or a link inside that points outside, still asks', async () => {
    expect(await tierOf(`cat ${join(outside, 'secret.txt')}`, root, undefined)).toBe(3);
    expect(await tierOf(`cat ${join(root, 'link.txt')}`, root, undefined)).toBe(3);
  });
});
