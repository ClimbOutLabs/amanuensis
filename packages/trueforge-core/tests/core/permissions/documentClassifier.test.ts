import {
  CREATE_DOCUMENT_REPORT_TOOL_NAME,
  SUMMARIZE_NET_WORTH_TOOL_NAME,
} from '../../../src/core/capabilities/builtins/DocumentTools';
import type { DocumentScope } from '../../../src/core/llm/LLMTypes';
import { actionIdFor, verifyApprovalToken } from '../../../src/core/permissions/approvalTokens';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../src/documents/toolContract';

const SCOPE: DocumentScope = {
  staged_uploads_dir: '/workspace/.aman/uploads',
  workspace_cwd: '/workspace',
  path_resolution: 'remote',
};

function makeCtx(services: SentinelServices, workspaceCwd: string | null = '/workspace'): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: workspaceCwd,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    path_resolution: 'remote',
  };
}

function freshCtx(workspaceCwd: string | null = '/workspace'): ClassifyContext {
  return makeCtx(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), workspaceCwd);
}

function extractAction(file_paths: unknown, scope: DocumentScope | undefined = SCOPE): SentinelAction {
  return {
    tool_name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
    canonical_params: { file_paths },
    tool_type: 'truefoundry-system',
    mcp_server_name: 'documents',
    mcp_hints: { read_only_hint: true, destructive_hint: false, open_world_hint: false },
    document_scope: scope,
  };
}

describe('document read classification', () => {
  it('reads a staged upload without asking', async () => {
    const decision = await classifyTier(
      extractAction(['/workspace/.aman/uploads/attachment-01-deadbeef-report.pdf']),
      freshCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, reason: 'document_read', card: null, approval_token_id: null });
  });

  it('reads a file inside the project folder without asking, by absolute or relative path', async () => {
    const absolute = await classifyTier(extractAction(['/workspace/docs/report.pdf']), freshCtx());
    expect(absolute).toMatchObject({ tier: 1, reason: 'document_read' });
    const relative = await classifyTier(extractAction(['docs/report.pdf']), freshCtx());
    expect(relative).toMatchObject({ tier: 1, reason: 'document_read' });
  });

  it('asks before reading a file outside the project folder, naming the exact path on the card', async () => {
    const decision = await classifyTier(extractAction(['/outside/report.pdf']), freshCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('document_outside_workspace');
    expect(decision.secret_path_read).toBe(true);
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.plain_what).toContain('/outside/report.pdf');
    expect(decision.card?.plain_what).toContain('outside the project folder');
  });

  it('asks when one path of several is outside, and the card names only that path', async () => {
    const decision = await classifyTier(
      extractAction(['/workspace/docs/report.pdf', '/outside/secret.pdf']),
      freshCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.card?.plain_what).toContain('/outside/secret.pdf');
    expect(decision.card?.plain_what).not.toContain('/workspace/docs/report.pdf');
  });

  it('binds the approval to the exact paths: the same paths verify, different paths do not', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    const ctx = makeCtx(services);
    const params = { file_paths: ['/outside/report.pdf'] };
    const decision = await classifyTier(extractAction(params.file_paths), ctx);
    const tokenId = decision.approval_token_id;
    if (tokenId === null) {
      throw new Error('expected an approval token');
    }
    const token = await services.token_store.redeem({ token_id: tokenId, tenant_id: 't1', created_by: 'u1' });
    if (token === undefined) {
      throw new Error('expected the minted token to be redeemable');
    }
    expect(
      verifyApprovalToken({
        token,
        action_id: actionIdFor({ tool_name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME, canonical_params: params }),
        canonical_params: params,
      }),
    ).toEqual({ valid: true });
    expect(
      verifyApprovalToken({
        token,
        action_id: actionIdFor({
          tool_name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
          canonical_params: { file_paths: ['/outside/other.pdf'] },
        }),
        canonical_params: { file_paths: ['/outside/other.pdf'] },
      }).valid,
    ).toBe(false);
  });

  it('asks for a non-staged path when no project folder is bound, and still reads staged uploads freely', async () => {
    const noWorkspace: DocumentScope = {
      staged_uploads_dir: '/workspace/.aman/uploads',
      workspace_cwd: null,
      path_resolution: 'remote',
    };
    const outside = await classifyTier(extractAction(['/anywhere/report.pdf'], noWorkspace), freshCtx(null));
    expect(outside).toMatchObject({ tier: 3, reason: 'document_outside_workspace' });
    const staged = await classifyTier(
      extractAction(['/workspace/.aman/uploads/attachment-01-deadbeef-report.pdf'], noWorkspace),
      freshCtx(null),
    );
    expect(staged).toMatchObject({ tier: 1, reason: 'document_read' });
  });

  it('flags a secret-named file inside the project folder as a sensitive read', async () => {
    const decision = await classifyTier(extractAction(['/workspace/id_rsa.pdf']), freshCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'document_read', sensitive_read: true });
  });

  it('fails closed when the paths cannot be checked', async () => {
    const decision = await classifyTier(extractAction('not-a-list'), freshCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified', card: null });
  });

  it('leaves the other documents tools on their current classification', async () => {
    const report = await classifyTier(
      {
        tool_name: CREATE_DOCUMENT_REPORT_TOOL_NAME,
        canonical_params: { title: 'Summary', summary: 'Draft', sections: [], notes: [] },
        tool_type: 'truefoundry-system',
        mcp_server_name: 'documents',
        mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
        document_scope: SCOPE,
      },
      freshCtx(),
    );
    expect(report.tier).toBe(3);
    expect(report.reason).not.toBe('document_read');
    expect(report.reason).not.toBe('document_outside_workspace');

    const netWorth = await classifyTier(
      {
        tool_name: SUMMARIZE_NET_WORTH_TOOL_NAME,
        canonical_params: { file_paths: ['/outside/report.pdf'], observations: [], title: 'Net Worth Summary' },
        tool_type: 'truefoundry-system',
        mcp_server_name: 'documents',
        mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
        document_scope: SCOPE,
      },
      freshCtx(),
    );
    expect(netWorth.tier).toBe(3);
    expect(netWorth.reason).not.toBe('document_read');
    expect(netWorth.reason).not.toBe('document_outside_workspace');
  });
});
