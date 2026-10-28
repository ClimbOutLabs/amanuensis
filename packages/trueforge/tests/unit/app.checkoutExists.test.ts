import type { SessionRecord, TurnRecord } from '@truefoundry/trueforge-core/agent-session';
import {
  SandboxFileNotFoundError,
  SandboxNotAvailableError,
  type ExecResult,
  type SandboxDownloadFileParams,
  type SandboxExecParams,
  type SandboxProvider,
  type VerifiedWorkspaceCommitResult,
} from '@truefoundry/trueforge-core/core';
import { Hono, type Context } from 'hono';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from 'winston';
import { resolveCheckoutExistsInSessionSandbox } from '../../src/app';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import type { ISandboxProviderStore } from '../../src/db/sandboxProviderStore';
import type { SessionCustom, TurnCustom } from '../../src/db/sessionCustom';
import { createSqliteDb } from '../../src/db/sqlite/client';
import { SqliteSandboxProviderStore } from '../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';

const execFileAsync = promisify(execFile);

const SESSION_ID = 'session-1';
const TURN_ID = 't1';

/** Runs a command the way the local sandbox provider does: in a shell, in the given folder. */
function runShellCommand(input: {
  command: string;
  cwd: string | undefined;
}): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', input.command], { cwd: input.cwd });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ exitCode: code ?? 1, stdout });
    });
  });
}

/** A provider whose exec really runs the command on this machine, so git answers for real folders. */
class HostGitProvider implements SandboxProvider {
  readonly type = 'hostgit';
  readonly execCalls: SandboxExecParams[] = [];

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    this.execCalls.push(params);
    try {
      const { exitCode, stdout } = await runShellCommand({ command: params.command, cwd: params.cwd });
      return { success: true, response: { exitCode, result: stdout } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  buildImage() {
    return Promise.resolve({ status: 'ready' as const, reason: null, metadata: null });
  }

  getImageBuildStatus() {
    return Promise.resolve({ status: 'ready' as const, reason: null, metadata: null });
  }

  createSandbox() {
    return Promise.resolve({ sandboxId: 'hostgit-sandbox' });
  }

  executeVerifiedWorkspaceCommit(): Promise<VerifiedWorkspaceCommitResult> {
    return Promise.reject(new Error('executeVerifiedWorkspaceCommit is not used by this test'));
  }

  acknowledgeWorkspaceTermination(): Promise<void> {
    return Promise.resolve();
  }

  getAdditionalInstructions() {
    return undefined;
  }

  getWorkspaceDir() {
    return undefined;
  }

  getToolResultDumpDir() {
    return '/tmp/tool-results';
  }

  getGitCredentialsPath() {
    return '/tmp/.git-credentials';
  }

  getFileUploadsDir() {
    return '/tmp/uploads';
  }

  getSkillsDir() {
    return '/tmp/skills';
  }

  getSkillDownloaderPath() {
    return '/tmp/skill_downloader.py';
  }

  downloadFile(params: SandboxDownloadFileParams): Promise<Buffer> {
    return Promise.reject(new SandboxFileNotFoundError(params.path));
  }

  uploadFile(): Promise<void> {
    return Promise.resolve();
  }

  createCodeModeTransport(): never {
    throw new Error('Code Mode is not configured in this test');
  }
}

/** A provider that answers every exec by throwing, the way a provider does for a sandbox it does not know. */
class ThrowingExecProvider extends HostGitProvider {
  constructor(private readonly failure: Error) {
    super();
  }

  override exec(): Promise<ExecResult> {
    return Promise.reject(this.failure);
  }
}

function sessionRecord(lastTurnId: string | null): SessionRecord<SessionCustom> {
  return {
    tenant_id: 'default',
    session_id: SESSION_ID,
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: { type: 'reference', id: 'agent-1', name: 'test-agent' },
    title: null,
    folder_id: null,
    repository_id: null,
    workspace_cwd: null,
    external_id: null,
    source: null,
    last_turn_id: lastTurnId,
    created_at: new Date('2026-07-31T00:00:00.000Z'),
    updated_at: new Date('2026-07-31T00:00:00.000Z'),
    last_activity_timestamp_ms: 0,
    approval_grants: [],
    task_checklist: { revision: 0, items: [] },
    metrics: { total_duration_ms: 0, total_turns: 0 },
    metadata: {},
    custom: null,
  };
}

function turnWithSandbox(sandboxId: string): TurnRecord<TurnCustom> {
  const createdAt = new Date('2026-07-31T00:00:00.000Z');
  return {
    turn_id: TURN_ID,
    session_id: SESSION_ID,
    first_turn_id: TURN_ID,
    ancestor_ids: [],
    previous_turn_id: null,
    state: { status: 'running' },
    input: [],
    snapshot: { threads: {}, mcp_servers: null, sandbox_info: { sandbox_id: sandboxId } },
    created_at: createdAt,
    updated_at: createdAt,
    custom: null,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function makeCheckoutWithCommit(root: string): Promise<string> {
  const dir = join(root, 'checkout');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), '# Demo\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'First commit',
  ]);
  return dir;
}

async function makeInitOnlyRepo(root: string): Promise<string> {
  const dir = join(root, 'init-only');
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-b', 'main']);
  return dir;
}

/** The shape an interrupted clone leaves: a .git with the standard folders but no refs and no commits. */
async function makeInterruptedCloneLeftover(root: string): Promise<string> {
  const dir = join(root, 'interrupted-clone');
  const gitDir = join(dir, '.git');
  await mkdir(join(gitDir, 'objects'), { recursive: true });
  await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true });
  await mkdir(join(gitDir, 'refs', 'tags'), { recursive: true });
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await mkdir(join(gitDir, 'hooks'), { recursive: true });
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(
    join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n' +
      '[remote "origin"]\n\turl = https://example.com/demo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  );
  return dir;
}

async function makeFolderInsideParentRepo(root: string): Promise<string> {
  const parent = await makeCheckoutWithCommit(root);
  const inner = join(parent, 'nested');
  await mkdir(inner, { recursive: true });
  return inner;
}

async function testContext(): Promise<Context> {
  const app = new Hono();
  let captured: Context | undefined;
  app.get('/', c => {
    captured = c;
    return c.text('ok');
  });
  await app.request('/');
  if (captured === undefined) {
    throw new Error('the test app did not hand back a context');
  }
  return captured;
}

describe('resolveCheckoutExistsInSessionSandbox', () => {
  let sandboxProviderStore: ISandboxProviderStore;
  let root: string;
  let c: Context;

  beforeAll(async () => {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    sandboxProviderStore = new SqliteSandboxProviderStore(db);
    c = await testContext();
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tfy-checkout-exists-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function depsFor(input: {
    session: SessionRecord<SessionCustom> | undefined;
    turn: TurnRecord<TurnCustom> | undefined;
    provider: SandboxProvider | undefined;
  }): Parameters<typeof resolveCheckoutExistsInSessionSandbox>[0]['deps'] {
    return {
      logger: createLogger({ silent: true }),
      resolveSandboxProviderStore: () => sandboxProviderStore,
      sandboxProviderResolver: () => Promise.resolve(input.provider),
      sessionStore: {
        getSession: () => Promise.resolve(input.session),
        getTurn: () => Promise.resolve(input.turn),
      },
    };
  }

  async function check(input: {
    session: SessionRecord<SessionCustom> | undefined;
    turn: TurnRecord<TurnCustom> | undefined;
    provider: SandboxProvider | undefined;
    workspace_cwd: string;
  }): Promise<boolean> {
    return resolveCheckoutExistsInSessionSandbox({
      c,
      deps: depsFor(input),
      session_id: SESSION_ID,
      workspace_cwd: input.workspace_cwd,
    });
  }

  it('passes for a real checkout with a commit', async () => {
    const dir = await makeCheckoutWithCommit(root);
    const provider = new HostGitProvider();
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider,
        workspace_cwd: dir,
      }),
    ).resolves.toBe(true);
    expect(provider.execCalls.map(call => call.command)).toEqual([
      'git rev-parse --show-toplevel',
      'git rev-parse HEAD',
    ]);
    expect(provider.execCalls.map(call => call.sandboxId)).toEqual(['sandbox-1', 'sandbox-1']);
  });

  it('refuses an empty folder with no repo in it', async () => {
    const dir = join(root, 'empty');
    await mkdir(dir, { recursive: true });
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider: new HostGitProvider(),
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
  });

  it('refuses a repo that was initialised but has no commits yet', async () => {
    const dir = await makeInitOnlyRepo(root);
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider: new HostGitProvider(),
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
  });

  it('refuses the leftover of an interrupted clone', async () => {
    const dir = await makeInterruptedCloneLeftover(root);
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider: new HostGitProvider(),
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
  });

  it('refuses a folder inside a parent repo, whose checkout root is the parent', async () => {
    const inner = await makeFolderInsideParentRepo(root);
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider: new HostGitProvider(),
        workspace_cwd: inner,
      }),
    ).resolves.toBe(false);
  });

  it('refuses without asking the provider when the recorded sandbox belongs to another provider', async () => {
    const dir = await makeCheckoutWithCommit(root);
    const provider = new HostGitProvider();
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:daytona:sandbox-9'),
        provider,
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
    expect(provider.execCalls).toEqual([]);
  });

  it('returns false instead of throwing when the provider rejects the recorded sandbox', async () => {
    const dir = await makeCheckoutWithCommit(root);
    const provider = new ThrowingExecProvider(new SandboxNotAvailableError('sandbox-1'));
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider,
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
  });

  it('returns false instead of throwing when the provider exec fails outright', async () => {
    const dir = await makeCheckoutWithCommit(root);
    const provider = new ThrowingExecProvider(new Error('provider is down'));
    await expect(
      check({
        session: sessionRecord(TURN_ID),
        turn: turnWithSandbox('v1:hostgit:sandbox-1'),
        provider,
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
  });

  it('refuses when the chat is gone or never ran in a sandbox', async () => {
    const dir = await makeCheckoutWithCommit(root);
    await expect(
      check({ session: undefined, turn: undefined, provider: new HostGitProvider(), workspace_cwd: dir }),
    ).resolves.toBe(false);
    await expect(
      check({
        session: sessionRecord(null),
        turn: undefined,
        provider: new HostGitProvider(),
        workspace_cwd: dir,
      }),
    ).resolves.toBe(false);
  });
});
