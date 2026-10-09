import { classifyHostToolCall, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  createSentinelHostContext,
  getSharedSentinelServices,
  resetSharedSentinelServicesForTests,
  toDispatchSentinelContext,
  DEFAULT_PINNED_PATH,
} from '../../../src/core/permissions/context';
import { verifyPreDispatch } from '../../../src/core/permissions/dispatch';

beforeEach(() => {
  resetSharedSentinelServicesForTests();
});

function tier3Action(): SentinelAction {
  return {
    tool_name: 'exec',
    canonical_params: { command: 'curl https://example.com' },
    tool_type: 'truefoundry-system',
    mcp_hints: {},
  };
}

function hostFor(conversationId: string) {
  return createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: conversationId,
  });
}

describe('getSharedSentinelServices', () => {
  test('returns the same instance across calls', () => {
    const a = getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH });
    const b = getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH });
    expect(a).toBe(b);
  });

  test('reset drops the cached instance', () => {
    const a = getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH });
    resetSharedSentinelServicesForTests();
    const b = getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH });
    expect(a).not.toBe(b);
  });

  test('createSentinelHostContext without explicit services uses the shared store', () => {
    const host = hostFor('conv-1');
    expect(host.services).toBe(getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }));
  });

  test('explicit services are honored over the shared default', () => {
    const explicit = getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH });
    const other = {
      ...explicit,
      token_store: explicit.token_store,
    };
    const host = createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      services: other,
    });
    expect(host.services).toBe(other);
  });
});

describe('cross-turn approval token flow', () => {
  test('token minted at classify time redeems at dispatch time in a later turn', async () => {
    // Turn N: classify with a host built without explicit services.
    // The shared fallback supplies the token store.
    const hostN = hostFor('conv-1');
    const decision = await classifyHostToolCall({
      sentinel: hostN,
      repository_id: null,
      workspace_cwd: null,
      action: tier3Action(),
    });
    expect(decision.tier).toBe(3);
    expect(decision.approval_token_id).not.toBeNull();
    const tokenId = decision.approval_token_id as string;

    // Turn N+1: a fresh host (new turn), also without explicit services.
    // Before the fix this built a different in-memory store and the redeem
    // below returned undefined ("token invalid or already used").
    const hostN1 = hostFor('conv-1');
    const dispatch = toDispatchSentinelContext(hostN1);
    expect(dispatch).toBeDefined();
    if (dispatch === undefined) {
      return;
    }

    const redeemed = dispatch.services.token_store.redeem({ token_id: tokenId });
    expect(redeemed).toBeDefined();
  });

  test('full dispatch verification passes across turns', async () => {
    const params = { command: 'curl https://example.com' };
    const hostN = hostFor('conv-1');
    const decision = await classifyHostToolCall({
      sentinel: hostN,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: 'exec',
        canonical_params: params,
        tool_type: 'truefoundry-system',
        mcp_hints: {},
      },
    });
    expect(decision.tier).toBe(3);
    const tokenId = decision.approval_token_id as string;

    const hostN1 = hostFor('conv-1');
    const dispatch = toDispatchSentinelContext(hostN1);
    expect(dispatch).toBeDefined();
    if (dispatch === undefined) {
      return;
    }

    const result = await verifyPreDispatch({
      call: {
        tool_name: 'exec',
        tool_type: 'truefoundry-system',
        canonical_params: params,
        tier: 3,
        approval_token_id: tokenId,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: {
        services: dispatch.services,
        tenant_id: dispatch.identity.tenant_id,
        created_by: dispatch.identity.created_by,
        conversation_id: dispatch.identity.conversation_id,
        repository_id: dispatch.identity.repository_id,
        workspace_cwd: dispatch.identity.workspace_cwd,
        agent_intent: dispatch.identity.agent_intent,
        offline: false,
      },
    });
    expect(result).toBeUndefined();
  });

  test('tampered params still fail verification under the shared store', async () => {
    const params = { command: 'curl https://example.com' };
    const host = hostFor('conv-1');
    const decision = await classifyHostToolCall({
      sentinel: host,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: 'exec',
        canonical_params: params,
        tool_type: 'truefoundry-system',
        mcp_hints: {},
      },
    });
    expect(decision.tier).toBe(3);
    const tokenId = decision.approval_token_id as string;

    const dispatch = toDispatchSentinelContext(host);
    expect(dispatch).toBeDefined();
    if (dispatch === undefined) {
      return;
    }

    const result = await verifyPreDispatch({
      call: {
        tool_name: 'exec',
        tool_type: 'truefoundry-system',
        canonical_params: { command: 'curl https://evil.example.com' },
        tier: 3,
        approval_token_id: tokenId,
        approval_binding: null,
        shell_binding: null,
      },
      ctx: {
        services: dispatch.services,
        tenant_id: dispatch.identity.tenant_id,
        created_by: dispatch.identity.created_by,
        conversation_id: dispatch.identity.conversation_id,
        repository_id: dispatch.identity.repository_id,
        workspace_cwd: dispatch.identity.workspace_cwd,
        agent_intent: dispatch.identity.agent_intent,
        offline: false,
      },
    });
    expect(result).toMatch(/changed|invalid/i);
  });

  test('a redeemed token cannot be reused across turns', async () => {
    const host = hostFor('conv-1');
    const decision = await classifyHostToolCall({
      sentinel: host,
      repository_id: null,
      workspace_cwd: null,
      action: tier3Action(),
    });
    const tokenId = decision.approval_token_id as string;

    const store = getSharedSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }).token_store;
    expect(store.redeem({ token_id: tokenId })).toBeDefined();
    expect(store.redeem({ token_id: tokenId })).toBeUndefined();
  });
});
