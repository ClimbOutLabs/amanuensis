import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { IRepositoryStore } from '../../../src/db/repositoryStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import {
  deriveRepositoryCommandProposals,
  synchronizeRepositoryCommandProposals,
} from '../../../src/runtime/repositoryCommandProposals';

const OWNER = { tenant_id: 'tenant-a', created_by: 'owner-a' };

describe('repository command proposals', () => {
  it('derives only explicit package scripts using the declared package manager', () => {
    const proposals = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [],
      sources: [
        {
          source_kind: 'package_json',
          source_path: 'package.json',
          source_fingerprint: 'sha256:package-a',
          content: JSON.stringify({
            packageManager: 'pnpm@10.15.1',
            scripts: {
              build: 'tsc -b',
              test: 'jest',
              verify: 'pnpm lint && pnpm test',
              lint: 'eslint .',
            },
          }),
        },
      ],
    });

    expect(proposals.map(proposal => ({ purpose: proposal.purpose, command: proposal.command }))).toEqual([
      { purpose: 'build', command: 'pnpm run build' },
      { purpose: 'test', command: 'pnpm run test' },
      { purpose: 'verify', command: 'pnpm run verify' },
    ]);
  });

  it('accepts only explicit AGENTS command declarations and ignores prose examples', () => {
    const proposals = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [],
      sources: [
        {
          source_kind: 'agents_md',
          source_path: 'AGENTS.md',
          source_fingerprint: 'sha256:agents-a',
          content: [
            '# Repository guide',
            'You may run cargo test while debugging.',
            '- Build: `cargo build --workspace`',
            '- Test command: `cargo test --workspace`',
            '- Verify: `./scripts/validate.sh`',
            '- Deploy: `./scripts/deploy.sh`',
          ].join('\n'),
        },
      ],
    });

    expect(proposals.map(proposal => ({ purpose: proposal.purpose, command: proposal.command }))).toEqual([
      { purpose: 'build', command: 'cargo build --workspace' },
      { purpose: 'test', command: 'cargo test --workspace' },
      { purpose: 'verify', command: './scripts/validate.sh' },
    ]);
  });

  it('keeps stable proposal ids and suppresses already confirmed commands', () => {
    const source = {
      source_kind: 'package_json' as const,
      source_path: 'package.json',
      source_fingerprint: 'sha256:first',
      content: JSON.stringify({ scripts: { test: 'jest', verify: 'pnpm test' } }),
    };
    const first = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [{ command: 'npm run test' }],
      sources: [source],
    });
    const refreshed = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [{ command: 'npm run test' }],
      sources: [{ ...source, source_fingerprint: 'sha256:second' }],
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.command).toBe('npm run verify');
    expect(refreshed[0]?.id).toBe(first[0]?.id);
    expect(refreshed[0]?.source_fingerprint).toBe('sha256:second');
  });

  it('synchronizes observed sources and removes proposals that disappeared from them', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteRepositoryStore(db);
    const repository = await store.createRepository({
      ...OWNER,
      name: 'demo',
      clone_url: 'https://example.test/demo.git',
      default_branch: 'main',
    });
    const packageSource = {
      source_kind: 'package_json' as const,
      source_path: 'package.json',
      source_fingerprint: 'sha256:first',
      content: JSON.stringify({ scripts: { build: 'tsc', test: 'jest' } }),
    };

    await synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: repository.id,
      sources: [packageSource],
      store,
      signal: undefined,
    });
    expect(
      (await store.listVerifyCommandProposals({ ...OWNER, repository_id: repository.id }))
        .map(item => item.purpose)
        .sort(),
    ).toEqual(['build', 'test']);

    await synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: repository.id,
      sources: [
        {
          ...packageSource,
          source_fingerprint: 'sha256:second',
          content: JSON.stringify({ scripts: { test: 'jest' } }),
        },
      ],
      store,
      signal: undefined,
    });
    expect(
      (await store.listVerifyCommandProposals({ ...OWNER, repository_id: repository.id })).map(item => item.purpose),
    ).toEqual(['test']);

    await synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: repository.id,
      sources: [],
      store,
      signal: undefined,
    });
    expect(await store.listVerifyCommandProposals({ ...OWNER, repository_id: repository.id })).toEqual([]);
  });

  it('does not change repository revision when synchronized proposals are unchanged', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteRepositoryStore(db);
    const repository = await store.createRepository({
      ...OWNER,
      name: 'stable-proposals',
      clone_url: 'https://example.test/stable.git',
      default_branch: 'main',
    });
    const sources = [
      {
        source_kind: 'package_json' as const,
        source_path: 'package.json',
        source_fingerprint: 'sha256:stable',
        content: JSON.stringify({ scripts: { verify: 'pnpm test' } }),
      },
    ];

    await synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: repository.id,
      sources,
      store,
      signal: undefined,
    });
    const firstRevision = (await store.getRepository({ ...OWNER, repository_id: repository.id }))?.revision;

    await synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: repository.id,
      sources,
      store,
      signal: undefined,
    });

    expect((await store.getRepository({ ...OWNER, repository_id: repository.id }))?.revision).toBe(firstRevision);
  });

  it('does not admit a proposal write after cancellation during the preceding read', async () => {
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const replaceVerifyCommandProposals = jest.fn(() => Promise.resolve());
    const store: Pick<
      IRepositoryStore,
      'getRepository' | 'listVerifyCommands' | 'listVerifyCommandProposals' | 'replaceVerifyCommandProposals'
    > = {
      getRepository: async () => ({
        id: 'repo-a',
        ...OWNER,
        name: 'demo',
        clone_url: 'https://example.test/demo.git',
        default_branch: 'main',
        package_downloads_allowed: false,
        revision: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
      listVerifyCommands: async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return [];
      },
      listVerifyCommandProposals: async () => [],
      replaceVerifyCommandProposals: async input => {
        void input;
        await replaceVerifyCommandProposals();
      },
    };
    const controller = new AbortController();

    const synchronization = synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: 'repo-a',
      sources: [
        {
          source_kind: 'package_json',
          source_path: 'package.json',
          source_fingerprint: 'sha256:cancelled',
          content: JSON.stringify({ scripts: { test: 'jest' } }),
        },
      ],
      store,
      signal: controller.signal,
    });
    await readStarted.promise;
    controller.abort(new Error('cancel proposal synchronization'));
    releaseRead.resolve();

    await expect(synchronization).rejects.toThrow('cancel proposal synchronization');
    expect(replaceVerifyCommandProposals).not.toHaveBeenCalled();
  });

  it('prefers explicit hatch scripts over inferred pyproject tool table commands', () => {
    const proposals = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [],
      sources: [
        {
          source_kind: 'pyproject_toml',
          source_path: 'pyproject.toml',
          source_fingerprint: 'sha256:pyproject-a',
          content: [
            '[build-system]',
            'requires = ["hatchling"]',
            '',
            '[tool.pytest.ini_options]',
            'testpaths = ["tests"]',
            '',
            '[tool.ruff.lint]',
            'select = ["E"]',
            '',
            '[tool.hatch.envs.default.scripts]',
            'test = "pytest -q"',
            'lint = "ruff check ."',
            '',
            '[tool.hatch.envs.types.scripts]',
            'check = "mypy src"',
          ].join('\n'),
        },
      ],
    });

    expect(proposals.map(proposal => ({ purpose: proposal.purpose, command: proposal.command }))).toEqual([
      { purpose: 'test', command: 'pytest -q' },
      { purpose: 'verify', command: 'ruff check .' },
    ]);
  });

  it('derives no pyproject commands from a file without tool tables', () => {
    const proposals = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [],
      sources: [
        {
          source_kind: 'pyproject_toml',
          source_path: 'pyproject.toml',
          source_fingerprint: 'sha256:pyproject-b',
          content: ['[project]', 'name = "demo"', 'version = "1.0.0"'].join('\n'),
        },
      ],
    });

    expect(proposals).toEqual([]);
  });

  it('derives commands only from well known Makefile targets', () => {
    const proposals = deriveRepositoryCommandProposals({
      repository_id: 'repo-a',
      confirmed_commands: [],
      sources: [
        {
          source_kind: 'makefile',
          source_path: 'Makefile',
          source_fingerprint: 'sha256:makefile-a',
          content: [
            'VERSION := 1.0.0',
            '.PHONY: build test lint deploy',
            '',
            'build:',
            '\tgo build ./...',
            '',
            'test: build',
            '\tgo test ./...',
            '',
            'lint:',
            '\tgolangci-lint run',
            '',
            'deploy:',
            '\t./deploy.sh',
            '',
            '%.o: %.c',
            '\tcc -c $<',
          ].join('\n'),
        },
      ],
    });

    expect(proposals.map(proposal => ({ purpose: proposal.purpose, command: proposal.command }))).toEqual([
      { purpose: 'build', command: 'make build' },
      { purpose: 'test', command: 'make test' },
      { purpose: 'verify', command: 'make lint' },
    ]);
  });

  it('synchronizes pyproject and Makefile proposals into the store', async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const store = new SqliteRepositoryStore(db);
    const repository = await store.createRepository({
      ...OWNER,
      name: 'python-demo',
      clone_url: 'https://example.test/python-demo.git',
      default_branch: 'main',
    });

    await synchronizeRepositoryCommandProposals({
      ...OWNER,
      repository_id: repository.id,
      sources: [
        {
          source_kind: 'pyproject_toml',
          source_path: 'pyproject.toml',
          source_fingerprint: 'sha256:pyproject-c',
          content: ['[tool.pytest.ini_options]', '[tool.mypy]'].join('\n'),
        },
        {
          source_kind: 'makefile',
          source_path: 'Makefile',
          source_fingerprint: 'sha256:makefile-b',
          content: ['check:', '\t./check.sh'].join('\n'),
        },
      ],
      store,
      signal: undefined,
    });

    const stored = await store.listVerifyCommandProposals({ ...OWNER, repository_id: repository.id });
    expect(stored.map(item => `${item.source_kind}:${item.purpose}:${item.command}`).sort()).toEqual([
      'makefile:verify:make check',
      'pyproject_toml:test:pytest',
      'pyproject_toml:verify:mypy .',
    ]);
  });
});
