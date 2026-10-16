import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { DEMO_SEND_REFUSAL, recipientsAllowed } from '../../../src/core/permissions/sendAllowlist';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function ctx(demoSendAllowlist: readonly string[] | null): ClassifyContext {
  return {
    services: { ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }), demoSendAllowlist },
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: 'send a note',
    web_search: createWebSearchTurnState(),
  };
}

function connectorSend(params: Record<string, unknown>): SentinelAction {
  return {
    tool_name: 'send_email',
    canonical_params: params,
    tool_type: 'mcp',
    mcp_server_name: 'mail',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
  };
}

describe('recipientsAllowed', () => {
  it('allows anyone when there is no list', () => {
    expect(recipientsAllowed({ allowlist: null, recipients: ['anyone@example.com'] })).toBe(true);
  });

  it('allows no one when the list is empty', () => {
    expect(recipientsAllowed({ allowlist: [], recipients: ['maya@demo.example'] })).toBe(false);
  });

  it('ignores case and edge space on both sides', () => {
    expect(recipientsAllowed({ allowlist: [' Maya@Demo.Example'], recipients: ['MAYA@demo.example  '] })).toBe(true);
  });

  it('needs every recipient on the list', () => {
    expect(recipientsAllowed({ allowlist: ['a@demo.example'], recipients: ['a@demo.example', 'b@demo.example'] })).toBe(
      false,
    );
  });

  it('does not take a lookalike for a listed address', () => {
    expect(recipientsAllowed({ allowlist: ['a@demo.example'], recipients: ['a@demo.example.evil.test'] })).toBe(false);
  });
});

describe('demo send allowlist on connector sends', () => {
  it.each([
    ['To', { to: ['x@outside.example'] }],
    ['Cc', { to: 'a@demo.example', cc: ['x@outside.example'] }],
    ['Bcc', { to: 'a@demo.example', bcc: 'x@outside.example' }],
    ['a nested recipient', { to: 'a@demo.example', message: { recipients: [{ email: 'x@outside.example' }] } }],
  ])('refuses a stray %s with no card', async (_name, params) => {
    const decision = await classifyTier(
      connectorSend({ subject: 'Hi', body: 'Hi', ...params }),
      ctx(['a@demo.example']),
    );
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null, reason_detail: DEMO_SEND_REFUSAL });
  });

  it('refuses everything when the list is empty', async () => {
    const decision = await classifyTier(connectorSend({ to: 'a@demo.example', body: 'Hi' }), ctx([]));
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard' });
  });

  it('asks as usual when every recipient is listed, however it is written', async () => {
    const decision = await classifyTier(
      connectorSend({ to: ' A@Demo.example ', cc: ['a@demo.example'], body: 'Hi' }),
      ctx(['a@demo.example']),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.card).not.toBeNull();
  });

  it('is unchanged outside demo mode', async () => {
    const decision = await classifyTier(connectorSend({ to: 'x@outside.example', body: 'Hi' }), ctx(null));
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
  });
});
