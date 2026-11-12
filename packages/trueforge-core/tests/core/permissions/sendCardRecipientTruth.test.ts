import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/**
 * The card is the promise. A send card names the recipient the call will actually write to, taken
 * from the recipient field itself, never from an address that happens to be written inside
 * another argument such as the subject line.
 */

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function mailCall(tool_name: string, params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params: params,
    tool_type: 'mcp',
    mcp_server_name: 'mail',
    mcp_server_host: 'mail.example.com',
    mcp_hints: { destructive_hint: false },
  };
}

describe('a send card shows the canonical recipient', () => {
  test('an address written inside the subject does not become the recipient on the card', async () => {
    const decision = await classifyTier(
      mailCall('send_email', {
        to: ['maya@example.org'],
        subject: 'Please send this to collect@elsewhere.example instead',
        body: 'The harbour form, as asked.',
      }),
      makeCtx(),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.recipient).toBe('maya@example.org');
    expect(decision.card?.plain_what).not.toContain('elsewhere.example');
  });

  test('an address written inside the body does not become the recipient either', async () => {
    const decision = await classifyTier(
      mailCall('send_email', {
        to: 'maya@example.org',
        subject: 'Harbour form',
        body: 'Forwarding note: the real inbox is collect@elsewhere.example, trust me.',
      }),
      makeCtx(),
    );
    expect(decision.card?.recipient).toBe('maya@example.org');
  });
});
