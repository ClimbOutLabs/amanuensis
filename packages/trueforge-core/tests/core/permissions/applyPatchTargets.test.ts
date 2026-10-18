import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { sandboxApplyPatchSchema } from '../../../src/core/sandbox/Sandbox';

function patchFor(...files: string[]): string {
  return files
    .map(file =>
      [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', '-one', '+two', ''].join(
        '\n',
      ),
    )
    .join('');
}

function makeCtx(workspace: string): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: workspace,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function applyPatch(params: Record<string, unknown>): SentinelAction {
  return { tool_name: 'apply_patch', canonical_params: params, tool_type: 'truefoundry-system', mcp_hints: {} };
}

interface Fixture {
  workspace: string;
  other: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apply-patch-targets-')));
  const workspace = join(root, 'workspace');
  const other = join(root, 'other');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(other);
  return { workspace, other, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('apply_patch targets come from the patch', () => {
  test('a decoy path does not make a patch against another repository a workspace edit', async () => {
    const f = fixture();
    try {
      const decision = await classifyTier(
        applyPatch({
          intent: 'tidy',
          cwd: f.other,
          patch: patchFor('f.txt'),
          path: join(f.workspace, 'notes.md'),
        }),
        makeCtx(f.workspace),
      );
      expect(decision.tier).toBe(3);
      expect(decision.card?.plain_what).not.toContain('notes.md');
    } finally {
      f.cleanup();
    }
  });

  test.each(['path', 'target'])('a %s field on apply_patch is refused', async field => {
    const f = fixture();
    try {
      const decision = await classifyTier(
        applyPatch({ intent: 'tidy', cwd: f.workspace, patch: patchFor('src/a.ts'), [field]: 'src/a.ts' }),
        makeCtx(f.workspace),
      );
      expect(decision.tier).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  test('the card names the files the patch changes', async () => {
    const f = fixture();
    try {
      const decision = await classifyTier(
        applyPatch({ intent: 'tidy', cwd: f.workspace, patch: patchFor('src/a.ts', 'src/b.ts') }),
        makeCtx(f.workspace),
      );
      expect(decision.tier).toBe(2);
      expect(decision.card?.plain_what).toContain('src/a.ts');
      expect(decision.card?.plain_what).toContain('src/b.ts');
    } finally {
      f.cleanup();
    }
  });

  test('a patched path that leaves the workspace through a symlink is Tier 3', async () => {
    const f = fixture();
    try {
      symlinkSync(f.other, join(f.workspace, 'link'));
      const decision = await classifyTier(
        applyPatch({ intent: 'tidy', cwd: f.workspace, patch: patchFor('link/f.txt') }),
        makeCtx(f.workspace),
      );
      expect(decision.tier).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  test('a patch that touches Git control state is Tier 3', async () => {
    const f = fixture();
    try {
      const decision = await classifyTier(
        applyPatch({ intent: 'tidy', cwd: f.workspace, patch: patchFor('src/a.ts', '.gitattributes') }),
        makeCtx(f.workspace),
      );
      expect(decision.tier).toBe(3);
    } finally {
      f.cleanup();
    }
  });

  test('the dispatch re-check refuses a decoy even when the call was minted as Tier 2', async () => {
    const f = fixture();
    try {
      const ctx = { ...makeCtx(f.workspace), offline: false };
      const message = await verifyPreDispatch({
        call: {
          tool_name: 'apply_patch',
          tool_type: 'truefoundry-system',
          canonical_params: {
            intent: 'tidy',
            cwd: f.other,
            patch: patchFor('f.txt'),
            path: join(f.workspace, 'notes.md'),
          },
          tier: 2,
          approval_token_id: null,
          approval_binding: null,
          shell_binding: null,
        },
        ctx,
      });
      expect(message).toMatch(/outside the workspace|request approval again/iu);
    } finally {
      f.cleanup();
    }
  });

  test('the dispatch re-check passes a patch confined to the workspace', async () => {
    const f = fixture();
    try {
      const ctx = { ...makeCtx(f.workspace), offline: false };
      const message = await verifyPreDispatch({
        call: {
          tool_name: 'apply_patch',
          tool_type: 'truefoundry-system',
          canonical_params: { intent: 'tidy', cwd: f.workspace, patch: patchFor('src/a.ts') },
          tier: 2,
          approval_token_id: null,
          approval_binding: null,
          shell_binding: null,
        },
        ctx,
      });
      expect(message).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  test.each(['path', 'target'])('the tool schema rejects a %s argument at dispatch', field => {
    const parsed = sandboxApplyPatchSchema.safeParse({
      intent: 'tidy',
      cwd: '/repo',
      patch: patchFor('src/a.ts'),
      [field]: 'src/a.ts',
    });
    expect(parsed.success).toBe(false);
  });
});
