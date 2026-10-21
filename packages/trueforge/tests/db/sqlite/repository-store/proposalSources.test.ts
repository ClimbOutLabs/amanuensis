import { SqliteRepositoryStore } from '../../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteRepositoryStore proposal sources and package downloads', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  async function createRepository() {
    const store = new SqliteRepositoryStore(env.db);
    const repository = await store.createRepository({
      tenant_id: 'tenant-a',
      created_by: 'owner-a',
      name: 'seam',
      clone_url: 'https://example.test/seam.git',
      default_branch: 'main',
    });
    return { store, repository };
  }

  it('stores proposals that came from a Makefile and from pyproject.toml', async () => {
    const { store, repository } = await createRepository();
    const owner = {
      tenant_id: repository.tenant_id,
      created_by: repository.created_by,
      repository_id: repository.id,
    };
    await store.upsertVerifyCommandProposal({
      ...owner,
      id: 'from-makefile',
      purpose: 'test',
      command: 'make test',
      source_kind: 'makefile',
      source_path: 'Makefile',
      source_fingerprint: 'sha256:makefile',
    });
    await store.upsertVerifyCommandProposal({
      ...owner,
      id: 'from-pyproject',
      purpose: 'test',
      command: 'pytest',
      source_kind: 'pyproject_toml',
      source_path: 'pyproject.toml',
      source_fingerprint: 'sha256:pyproject',
    });
    const proposals = await store.listVerifyCommandProposals(owner);
    expect(proposals.map(proposal => proposal.source_kind).sort()).toEqual(['makefile', 'pyproject_toml']);
  });

  it('still stores the package downloads allowance on the same repository', async () => {
    const { store, repository } = await createRepository();
    expect(repository.package_downloads_allowed).toBe(false);
    const updated = await store.setPackageDownloadsAllowed({
      tenant_id: repository.tenant_id,
      created_by: repository.created_by,
      repository_id: repository.id,
      allowed: true,
      expected_revision: repository.revision,
    });
    expect(updated?.package_downloads_allowed).toBe(true);
  });
});
