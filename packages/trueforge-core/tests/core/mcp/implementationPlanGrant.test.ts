import {
  ImplementationPlanSchema,
  implementationPlanAllowsCommand,
  implementationPlanAllowsPaths,
  mintImplementationPlanGrant,
  parseImplementationPlanGrant,
  serializeImplementationPlanGrant,
} from '../../../src/core/mcp/implementationPlanGrant';
import { extractStructuredEditPaths } from '../../../src/core/sandbox/structuredEditPaths';

const plan = {
  repository_id: 'repository-a',
  repository_revision: 7,
  branch: 'codex/plan-grants',
  head_sha: 'abcdef012345',
  file_globs: ['packages/core/src/**/*.ts', 'packages/core/test/**/*.test.ts'],
  approach: 'Update the host admission boundary and verify its scope.',
  verify_command_ids: ['core-test'],
};

const owner = {
  tenant_id: 'tenant-a',
  created_by: 'user-a',
  session_id: 'session-a',
  workspace_cwd: '/repo',
  checkout_id: `sha256:${'1'.repeat(64)}`,
};

describe('implementation plan grants', () => {
  it('mints a deterministic structured grant that is bound to its session', () => {
    const first = mintImplementationPlanGrant({ ...owner, plan });
    const second = mintImplementationPlanGrant({ ...owner, plan });
    const otherSession = mintImplementationPlanGrant({ ...owner, session_id: 'session-b', plan });

    expect(first).toEqual(second);
    expect(first.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.grant_id).not.toBe(otherSession.grant_id);
    expect(parseImplementationPlanGrant(serializeImplementationPlanGrant(first))).toEqual(first);
  });

  it('binds integrity-derived identity to tenant, user, session, checkout, branch, and HEAD', () => {
    const baseline = mintImplementationPlanGrant({ ...owner, plan });
    const variants = [
      mintImplementationPlanGrant({ ...owner, tenant_id: 'tenant-b', plan }),
      mintImplementationPlanGrant({ ...owner, created_by: 'user-b', plan }),
      mintImplementationPlanGrant({ ...owner, session_id: 'session-b', plan }),
      mintImplementationPlanGrant({ ...owner, workspace_cwd: '/other-checkout', plan }),
      mintImplementationPlanGrant({ ...owner, checkout_id: `sha256:${'2'.repeat(64)}`, plan }),
      mintImplementationPlanGrant({ ...owner, plan: { ...plan, branch: 'main' } }),
      mintImplementationPlanGrant({ ...owner, plan: { ...plan, head_sha: 'fedcba987654' } }),
    ];

    expect(new Set(variants.map(grant => grant.grant_id)).size).toBe(variants.length);
    expect(variants.every(grant => grant.grant_id !== baseline.grant_id)).toBe(true);
  });

  it('canonicalizes set-like plan fields before hashing and persistence', () => {
    const canonical = mintImplementationPlanGrant({ ...owner, plan });
    const reordered = mintImplementationPlanGrant({
      ...owner,
      plan: {
        ...plan,
        file_globs: ['packages/core/test/**/*.test.ts', 'packages/core/src/**/*.ts', 'packages/core/src/**/*.ts'],
        verify_command_ids: ['core-test', 'core-test'],
      },
    });

    expect(reordered).toEqual(canonical);
  });

  it('bounds plan path and command arrays and their entries', () => {
    const invalidPlans = [
      { ...plan, file_globs: Array.from({ length: 129 }, (_, index) => `src/path-${String(index)}.ts`) },
      { ...plan, file_globs: [`src/${'x'.repeat(509)}`] },
      {
        ...plan,
        verify_command_ids: Array.from({ length: 65 }, (_, index) => `verify-${String(index)}`),
      },
      { ...plan, verify_command_ids: ['v'.repeat(257)] },
    ];

    for (const invalidPlan of invalidPlans) {
      expect(ImplementationPlanSchema.safeParse(invalidPlan).success).toBe(false);
    }
  });

  it('rejects invalid repository globs before minting a grant', () => {
    const invalidGlobs = [
      '../src/**/*.ts',
      './src/**/*.ts',
      '/src/**/*.ts',
      'src\\**\\*.ts',
      'src//*.ts',
      'src/line\nbreak.ts',
    ];

    for (const glob of invalidGlobs) {
      expect(
        ImplementationPlanSchema.safeParse({
          ...plan,
          file_globs: [glob],
        }).success,
      ).toBe(false);
      expect(() =>
        mintImplementationPlanGrant({
          ...owner,
          plan: { ...plan, file_globs: [glob] },
        }),
      ).toThrow();
    }
  });

  it('admits only named structured edit paths', () => {
    const grant = mintImplementationPlanGrant({ ...owner, plan });

    expect(implementationPlanAllowsPaths({ grant, paths: ['packages/core/src/core/mcp/approvalGrant.ts'] })).toBe(true);
    expect(implementationPlanAllowsPaths({ grant, paths: ['packages/core/src/runtime.ts'] })).toBe(true);
    expect(implementationPlanAllowsPaths({ grant, paths: ['packages/frontend/src/App.tsx'] })).toBe(false);
    expect(implementationPlanAllowsPaths({ grant, paths: ['../outside.ts'] })).toBe(false);
  });

  it('bounds matching work for adversarial long wildcard patterns and paths', () => {
    const repeatedDirectories = '**/'.repeat(15);
    const longSuffix = 'x'.repeat(450);
    const grant = mintImplementationPlanGrant({
      ...owner,
      plan: { ...plan, file_globs: [`${repeatedDirectories}${longSuffix}.ts`] },
    });
    const adversarialMiss = `${'a/'.repeat(15)}${'x'.repeat(449)}y.ts`;
    const startedAt = Date.now();

    expect(implementationPlanAllowsPaths({ grant, paths: [adversarialMiss] })).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(implementationPlanAllowsPaths({ grant, paths: [`${'a/'.repeat(15)}${longSuffix}.ts`] })).toBe(true);
    expect(implementationPlanAllowsPaths({ grant, paths: [`src/${'x'.repeat(1_021)}`] })).toBe(false);
  });

  it('admits only registered verification command IDs', () => {
    const grant = mintImplementationPlanGrant({ ...owner, plan });

    expect(implementationPlanAllowsCommand({ grant, command_id: 'core-test' })).toBe(true);
    expect(implementationPlanAllowsCommand({ grant, command_id: 'arbitrary-shell' })).toBe(false);
  });

  it('does not parse prose into a grant', () => {
    expect(parseImplementationPlanGrant('I approve packages/core/src/**/*.ts and core-test.')).toBeUndefined();
  });

  it('fails closed unless every old and new patch path is safely parsed and in scope', () => {
    const grant = mintImplementationPlanGrant({ ...owner, plan });
    const patchPaths = (patch: string) => {
      const resolution = extractStructuredEditPaths({
        kind: 'apply_patch',
        repositoryRoot: '/repo',
        cwd: '/repo',
        patch,
      });
      return resolution.status === 'valid' ? resolution.paths : undefined;
    };
    const rename = [
      'diff --git a/packages/core/src/old.ts b/packages/core/src/new.ts',
      'similarity index 100%',
      'rename from packages/core/src/old.ts',
      'rename to packages/core/src/new.ts',
    ].join('\n');
    const quoted = [
      'diff --git "a/packages/core/src/file name.ts" "b/packages/core/src/file name.ts"',
      '--- "a/packages/core/src/file name.ts"',
      '+++ "b/packages/core/src/file name.ts"',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n');
    const outsideSource = [
      'diff --git a/packages/frontend/src/App.tsx b/packages/frontend/src/App.tsx',
      '--- a/packages/frontend/src/App.tsx',
      '+++ b/packages/frontend/src/App.tsx',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n');
    const hiddenTraditionalSection = [
      quoted,
      '--- a/packages/frontend/src/secret.ts',
      '+++ b/packages/frontend/src/secret.ts',
      '@@ -1 +1 @@',
      '-private',
      '+exposed',
    ].join('\n');

    const renamePaths = patchPaths(rename);
    const quotedPaths = patchPaths(quoted);
    const outsidePaths = patchPaths(outsideSource);
    expect(renamePaths).toEqual(['packages/core/src/old.ts', 'packages/core/src/new.ts']);
    expect(renamePaths === undefined ? false : implementationPlanAllowsPaths({ grant, paths: renamePaths })).toBe(true);
    expect(quotedPaths).toEqual(['packages/core/src/file name.ts']);
    expect(outsidePaths).toEqual(['packages/frontend/src/App.tsx']);
    expect(quotedPaths === undefined ? false : implementationPlanAllowsPaths({ grant, paths: quotedPaths })).toBe(true);
    expect(outsidePaths === undefined ? false : implementationPlanAllowsPaths({ grant, paths: outsidePaths })).toBe(
      false,
    );
    expect(patchPaths(hiddenTraditionalSection)).toBeUndefined();
    expect(
      patchPaths(
        'diff --git a/packages/core/src/image.bin b/packages/core/src/image.bin\nGIT binary patch\nliteral 1\nA',
      ),
    ).toBeUndefined();
    expect(patchPaths('diff --git a/packages/core/src/only.ts')).toBeUndefined();
  });

  it('treats literal --- and +++ lines inside a counted hunk as content', () => {
    const patch = [
      'diff --git a/packages/core/src/runtime.ts b/packages/core/src/runtime.ts',
      '--- a/packages/core/src/runtime.ts',
      '+++ b/packages/core/src/runtime.ts',
      '@@ -1,2 +1,2 @@',
      '-before',
      '--- literal deleted content',
      '+after',
      '+++ literal added content',
    ].join('\n');

    expect(
      extractStructuredEditPaths({ kind: 'apply_patch', repositoryRoot: '/repo', cwd: '/repo', patch }),
    ).toMatchObject({ status: 'valid', paths: ['packages/core/src/runtime.ts'] });
  });

  it('fails closed for a malformed persisted grant after restart', () => {
    expect(parseImplementationPlanGrant('{"kind":"implementation_plan.v1"}')).toBeUndefined();
  });

  it('fails closed for a syntactically valid grant whose plan or identity was tampered', () => {
    const grant = mintImplementationPlanGrant({ ...owner, plan });
    const tamperedValues = [
      { ...grant, grant_id: `plan-${'0'.repeat(64)}` },
      { ...grant, plan_hash: `sha256:${'0'.repeat(64)}` },
      { ...grant, tenant_id: 'tenant-b' },
      { ...grant, created_by: 'user-b' },
      { ...grant, session_id: 'session-b' },
      { ...grant, workspace_cwd: '/other-checkout' },
      { ...grant, checkout_id: `sha256:${'2'.repeat(64)}` },
      { ...grant, plan: { ...grant.plan, repository_revision: 8 } },
      { ...grant, plan: { ...grant.plan, branch: 'main' } },
      { ...grant, plan: { ...grant.plan, head_sha: 'fedcba987654' } },
    ];

    for (const tampered of tamperedValues) {
      expect(parseImplementationPlanGrant(JSON.stringify(tampered))).toBeUndefined();
    }
  });
});
