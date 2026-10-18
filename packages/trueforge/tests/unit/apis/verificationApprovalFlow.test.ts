import { z } from '@hono/zod-openapi';
import { type Turn, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type {
  ExecResult,
  SandboxExecParams,
  SandboxProvider,
  VerifiedWorkspaceCommitParams,
  VerifiedWorkspaceCommitResult,
} from '@truefoundry/trueforge-core/core';
import { fakeTrackedState } from '../../../../trueforge-core/tests/core/sandbox/fakeTrackedState';
import { realCommand } from '../../../../trueforge-core/tests/core/sandbox/realCommandExec';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  COMMIT_ONLY_DIRECTIVE,
  RUN_DIRECTIVE_PREFIX,
  VERIFY_THEN_COMMIT_DIRECTIVE,
} from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const WORKSPACE_ROOT = '/repo';
const VERIFY_COMMAND = 'pnpm verify';
const COMMIT_COMMAND = 'git commit -m "verified change"';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Follow the scripted sandbox verification and commit sequence exactly.',
  config: {
    sandbox: { enabled: true, file_downloads: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function successfulResult(result: string): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result } });
}

class VerificationSandboxProvider implements SandboxProvider {
  readonly type = 'local';
  verifyInvocations = 0;
  commitInvocations = 0;
  sandboxCreations = 0;

  buildImage() {
    return Promise.resolve({ status: 'ready' as const, reason: null, metadata: null });
  }

  getImageBuildStatus() {
    return Promise.resolve({ status: 'ready' as const, reason: null, metadata: null });
  }

  createSandbox() {
    this.sandboxCreations += 1;
    return Promise.resolve({ sandboxId: 'approval-continuation-checkout' });
  }

  exec(params: SandboxExecParams): Promise<ExecResult> {
    const command = realCommand(params.command);
    if (command === VERIFY_COMMAND) {
      this.verifyInvocations += 1;
      return successfulResult('verification passed');
    }
    const gitResults: Readonly<Record<string, string>> = {
      'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD': `${WORKSPACE_ROOT}\ncodex/receipt-continuation\n0123456789abcdef`,
      'git rev-parse --show-toplevel': WORKSPACE_ROOT,
      'git rev-parse --absolute-git-dir': `${WORKSPACE_ROOT}/.git`,
      'git rev-parse --abbrev-ref HEAD': 'codex/receipt-continuation',
      'git rev-parse HEAD': '0123456789abcdef',
      [`ls -di -- .git '${WORKSPACE_ROOT}/.git'`]: `101 .git\n101 ${WORKSPACE_ROOT}/.git`,
      "git for-each-ref --include-root-refs --sort=refname --format='%(refname)%00%(objectname)%00%(symref)%00'":
        'HEAD\u00000123456789abcdef\u0000refs/heads/codex/receipt-continuation\u0000',
      'git ls-files -v -z': 'H src/verified.ts\u0000',
      ...fakeTrackedState([{ path: 'src/verified.ts', indexSha: '1'.repeat(40), worktreeSha: '2'.repeat(40) }]),
      'git ls-files --others --exclude-standard -z': '',
    };
    return successfulResult(gitResults[command] ?? 'ok');
  }

  executeVerifiedWorkspaceCommit(params: VerifiedWorkspaceCommitParams): Promise<VerifiedWorkspaceCommitResult> {
    if (
      params.sandboxId !== 'approval-continuation-checkout' ||
      params.workspaceRoot !== WORKSPACE_ROOT ||
      params.command !== COMMIT_COMMAND ||
      params.receipt.branch !== 'codex/receipt-continuation' ||
      params.receipt.head !== '0123456789abcdef'
    ) {
      return Promise.resolve({ status: 'blocked', reason: 'receipt did not identify this concrete checkout' });
    }
    this.commitInvocations += 1;
    return Promise.resolve({
      status: 'completed',
      result: {
        success: true,
        response: { exitCode: 0, result: '[codex/receipt-continuation abcdef0] verified change' },
      },
    });
  }

  acknowledgeWorkspaceTermination() {
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

  getGitDownloaderPath() {
    return '/tmp/git_downloader.py';
  }

  downloadFile() {
    return Promise.reject(new Error('optional repository command source is absent'));
  }

  uploadFile() {
    return Promise.resolve();
  }

  createCodeModeTransport(): never {
    throw new Error('Code Mode is not configured in this fixture');
  }
}

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createBoundSession(server: ApprovalTestServer): Promise<string> {
  const repositoryResponse = await server.request(
    '/api/v1/repositories',
    jsonInit({
      repository: {
        name: 'receipt-continuation',
        clone_url: 'https://example.test/receipt-continuation.git',
        default_branch: 'main',
      },
    }),
  );
  const repositoryBody: unknown = await repositoryResponse.json();
  if (repositoryResponse.status !== 201) {
    throw new Error(
      `repository create failed (${String(repositoryResponse.status)}): ${JSON.stringify(repositoryBody)}`,
    );
  }
  const repository = z.object({ data: z.object({ id: z.string() }).loose() }).parse(repositoryBody).data;

  const sessionResponse = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const sessionBody: unknown = await sessionResponse.json();
  if (sessionResponse.status !== 201) {
    throw new Error(`session create failed (${String(sessionResponse.status)}): ${JSON.stringify(sessionBody)}`);
  }
  const sessionId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(sessionBody).data.id;

  const bindingResponse = await server.request(`/api/v1/sessions/${sessionId}/repository`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repository_id: repository.id, workspace_cwd: WORKSPACE_ROOT }),
  });
  if (bindingResponse.status !== 200) {
    throw new Error(`repository bind failed (${String(bindingResponse.status)}): ${await bindingResponse.text()}`);
  }
  return sessionId;
}

function turnIdFromStream(streamBody: string): string {
  for (const line of streamBody.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
    if (event.type === 'turn.created') {
      return event.turn_id;
    }
  }
  throw new Error(`turn stream carried no turn.created event: ${streamBody.slice(0, 400)}`);
}

async function runTurn(input: {
  server: ApprovalTestServer;
  sessionId: string;
  items: TurnInputItem[];
}): Promise<Turn> {
  const response = await input.server.request(
    `/api/v1/sessions/${input.sessionId}/turns`,
    jsonInit({ input: input.items, stream: true }),
  );
  if (response.status !== 200) {
    throw new Error(`turn create failed (${String(response.status)}): ${await response.text()}`);
  }
  const turnId = turnIdFromStream(await response.text());
  const turnResponse = await input.server.request(`/api/v1/sessions/${input.sessionId}/turns/${turnId}`);
  const body: unknown = await turnResponse.json();
  return GetTurnResponseSchema.parse(body).data;
}

function pendingApproval(turn: Turn): { thread_id: string; tool_call_id: string } {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  for (const action of turn.state.required_actions) {
    if (action.type === 'tool.approval_required' && action.tool_calls[0] !== undefined) {
      return { thread_id: action.thread_id, tool_call_id: action.tool_calls[0].id };
    }
  }
  throw new Error(`turn has no pending approval: ${JSON.stringify(turn.state)}`);
}

function approve(pending: { thread_id: string; tool_call_id: string }): TurnInputItem[] {
  return [
    {
      type: 'user.tool_approval',
      thread_id: pending.thread_id,
      tool_call_id: pending.tool_call_id,
      approval: { status: 'allow', scope: 'once' },
    },
  ];
}

describe('verification receipt across approval-continuation turns', () => {
  it(
    'authorizes one separately approved commit in the next turn and no second commit',
    async () => {
      const provider = new VerificationSandboxProvider();
      const server = await startApprovalTestServer({ sandboxProvider: provider });
      try {
        const sessionId = await createBoundSession(server);
        const verifyApprovalTurn = await runTurn({
          server,
          sessionId,
          items: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${VERIFY_THEN_COMMIT_DIRECTIVE}` }],
        });
        expect(provider.verifyInvocations).toBe(0);
        const verifyApproval = pendingApproval(verifyApprovalTurn);

        const commitApprovalTurn = await runTurn({ server, sessionId, items: approve(verifyApproval) });
        expect(provider.verifyInvocations).toBe(1);
        expect(provider.commitInvocations).toBe(0);
        const commitApproval = pendingApproval(commitApprovalTurn);

        const committedTurn = await runTurn({ server, sessionId, items: approve(commitApproval) });
        expect(committedTurn.state.status).toBe('done');
        expect(provider.commitInvocations).toBe(1);
        expect(provider.sandboxCreations).toBe(1);

        const secondCommitApprovalTurn = await runTurn({
          server,
          sessionId,
          items: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${COMMIT_ONLY_DIRECTIVE}` }],
        });
        const secondCommitApproval = pendingApproval(secondCommitApprovalTurn);
        await runTurn({ server, sessionId, items: approve(secondCommitApproval) });
        expect(provider.commitInvocations).toBe(1);
      } finally {
        await server.close();
      }
    },
    TURN_TIMEOUT_MS,
  );
});
