import { PackageMirrorTokenRegistry } from '../../../../src/sandbox/mirrors/packageMirrorTokens';

const OWNER = { tenant_id: 'tenant-1', created_by: 'owner-1', session_id: 'session-1' };

describe('PackageMirrorTokenRegistry grants for chats without a project', () => {
  it('issues and resolves a grant with no repository', () => {
    const registry = new PackageMirrorTokenRegistry();
    const token = registry.issue({ ...OWNER });
    const grant = registry.resolve(token);
    expect(grant?.repository_id).toBeUndefined();
    expect(grant?.tenant_id).toBe('tenant-1');
    expect(grant?.created_by).toBe('owner-1');
    expect(grant?.session_id).toBe('session-1');
  });

  it('reissues the same live token for the same chat and scope', () => {
    const registry = new PackageMirrorTokenRegistry();
    expect(registry.issue({ ...OWNER })).toBe(registry.issue({ ...OWNER }));
    expect(registry.issue({ ...OWNER, repository_id: 'repo-1' })).toBe(
      registry.issue({ ...OWNER, repository_id: 'repo-1' }),
    );
  });

  it('keeps the project-less scope and a repository scope apart for the same chat', () => {
    const registry = new PackageMirrorTokenRegistry();
    const withoutProject = registry.issue({ ...OWNER });
    const withProject = registry.issue({ ...OWNER, repository_id: 'repo-1' });
    expect(withoutProject).not.toBe(withProject);
    expect(registry.resolve(withoutProject)?.repository_id).toBeUndefined();
    expect(registry.resolve(withProject)?.repository_id).toBe('repo-1');
  });

  it('revokePersonWithoutRepository drops only that person\u2019s project-less grants', () => {
    const registry = new PackageMirrorTokenRegistry();
    const mine = registry.issue({ ...OWNER });
    const mineInRepo = registry.issue({ ...OWNER, repository_id: 'repo-1' });
    const mineOtherChat = registry.issue({ ...OWNER, session_id: 'session-2' });
    const otherPerson = registry.issue({ tenant_id: 'tenant-1', created_by: 'owner-2', session_id: 'session-1' });
    const otherTenant = registry.issue({ tenant_id: 'tenant-2', created_by: 'owner-1', session_id: 'session-1' });

    registry.revokePersonWithoutRepository({ tenant_id: 'tenant-1', created_by: 'owner-1' });

    expect(registry.resolve(mine)).toBeUndefined();
    expect(registry.resolve(mineOtherChat)).toBeUndefined();
    expect(registry.resolve(mineInRepo)?.repository_id).toBe('repo-1');
    expect(registry.resolve(otherPerson)).toBeDefined();
    expect(registry.resolve(otherTenant)).toBeDefined();
  });

  it('revokeRepository leaves the project-less grants of the same chat alone', () => {
    const registry = new PackageMirrorTokenRegistry();
    const withoutProject = registry.issue({ ...OWNER });
    const withProject = registry.issue({ ...OWNER, repository_id: 'repo-1' });

    registry.revokeRepository({ tenant_id: 'tenant-1', created_by: 'owner-1', repository_id: 'repo-1' });

    expect(registry.resolve(withProject)).toBeUndefined();
    expect(registry.resolve(withoutProject)).toBeDefined();
  });

  it('a fresh token is issued after the old one is taken back', () => {
    const registry = new PackageMirrorTokenRegistry();
    const first = registry.issue({ ...OWNER });
    registry.revokePersonWithoutRepository({ tenant_id: 'tenant-1', created_by: 'owner-1' });
    const second = registry.issue({ ...OWNER });
    expect(second).not.toBe(first);
    expect(registry.resolve(second)).toBeDefined();
  });

  it('treats an empty repository id as no repository, and the project-less revoke reaches it', () => {
    const registry = new PackageMirrorTokenRegistry();
    const emptyId = registry.issue({ ...OWNER, repository_id: '' });
    expect(emptyId).toBe(registry.issue({ ...OWNER }));
    expect(registry.resolve(emptyId)?.repository_id).toBeUndefined();

    registry.revokePersonWithoutRepository({ tenant_id: 'tenant-1', created_by: 'owner-1' });

    expect(registry.resolve(emptyId)).toBeUndefined();
  });

  it('refuses a token it never issued', () => {
    const registry = new PackageMirrorTokenRegistry();
    registry.issue({ ...OWNER });
    expect(registry.resolve('ffffffffffffffffffffffffffffffff')).toBeUndefined();
  });
});
