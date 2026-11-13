import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { extractCardFields } from '../../../src/core/permissions/extractorRegistry';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/**
 * The unverifiable-destination rule is computed from what a call carries and from the tool's
 * declared annotations, never from the tool's name. `transmit_letter` and `relay_parcel` are
 * invented for these tests: they appear in no list anywhere in the codebase, and their names
 * contain none of the fragments the deleted name registry matched on.
 */

function makeCtx(services?: SentinelServices): ClassifyContext {
  return {
    services: services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function connectorCall(input: {
  tool_name: string;
  params: Record<string, unknown>;
  hints?: SentinelAction['mcp_hints'];
}): SentinelAction {
  return {
    tool_name: input.tool_name,
    canonical_params: input.params,
    tool_type: 'mcp',
    mcp_server_name: 'letters',
    mcp_server_host: 'letters.example.com',
    mcp_hints: input.hints ?? {},
  };
}

describe('an invented send tool with no listed name', () => {
  it('is auto-denied when it carries a message but no verifiable destination', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'transmit_letter', params: { body: 'See you at noon.' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('is auto-denied when it carries a message addressed by an opaque reference', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'transmit_letter', params: { address_ref: 'ops-team', body: 'See you at noon.' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('is auto-denied when it acts on a message it names but shows no destination', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'relay_parcel', params: { message_id: 'm1' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('is auto-denied as a forward, whose delivered content is the stored message the card cannot show', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'forward_parcel', params: { message_id: 'm1' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('is carded when it delivers words to a destination its arguments name, under any key', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'blast_notice', params: { channel: '#general', announcement: 'Release shipped.' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.destination).toBe('#general');
  });

  it('is refused when part of what it delivers to a named destination sits under a key the card would cut', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'blast_notice',
        params: { channel: '#general', ['k'.repeat(201)]: 'hello' },
      }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'incomplete_send_card', card: null });
  });

  it('only names a mailbox, a folder in the connector store, so it is carded, not denied', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'clear_bin', params: { mailbox: 'Trash' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
  });

  it('is auto-denied when its name is disguised and it points at a mailbox', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'clear_b\u200Bin', params: { mailbox: 'Trash' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('asks with a card when it carries a verifiable destination', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'transmit_letter', params: { to: 'friend@example.com', body: 'See you at noon.' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.recipient).toBe('friend@example.com');
  });

  it('is refused when its message to a named recipient hides characters the card cannot show', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'transmit_letter', params: { to: 'friend@example.com', body: 'hi\u200Bthere' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'incomplete_send_card', card: null });
  });

  it('is auto-denied while offline, like any external-service action', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.isOffline = () => Promise.resolve(true);
    const decision = await classifyTier(
      connectorCall({ tool_name: 'transmit_letter', params: { body: 'See you at noon.' } }),
      makeCtx(services),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'offline_mode' });
  });

  it('carries nothing out when it only looks something up, so it is carded, not denied', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'transmit_letter', params: { text: 'a long lookup string' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
  });
});

describe('a name from the deleted registry no longer decides', () => {
  it('a send_message that carries a verifiable destination is carded, not auto-denied', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'send_message', params: { to: 'friend@example.com', body: 'hi' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
  });

  it('a send_email whose annotations declare it a read is not auto-denied on its name', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'send_email',
        params: { subject: 'Quarterly numbers' },
        hints: { read_only_hint: true, open_world_hint: false },
      }),
      makeCtx(),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.tier).toBe(3);
    expect(decision.approval_token_id).not.toBeNull();
  });

  it('extraction reports the annotation distinction directly', () => {
    const declaredRead = extractCardFields({
      tool_name: 'send_email',
      canonical_params: { subject: 'Quarterly numbers' },
      tool_type: 'mcp',
      read_only_closed_world: true,
    });
    expect(declaredRead.external_service).toBe(true);
    expect(declaredRead.destination_unverifiable).toBe(false);
    const undeclared = extractCardFields({
      tool_name: 'send_email',
      canonical_params: { subject: 'Quarterly numbers' },
      tool_type: 'mcp',
    });
    expect(undeclared.destination_unverifiable).toBe(true);
  });
});

describe('the real send tools named in the finding keep their decisions', () => {
  it('send_email with a subject and no destination is auto-denied', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'send_email', params: { subject: 'hi' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('a payment that carries an amount but no destination is auto-denied', async () => {
    const decision = await classifyTier(
      connectorCall({ tool_name: 'make_payment', params: { amount: '40.00' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('a webhook call that delivers data to a named hook is carded with its destination', async () => {
    const decision = await classifyTier(
      connectorCall({
        tool_name: 'fire_webhook',
        params: { url: 'https://hooks.example.com/x', payload: 'release shipped' },
      }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, auto_deny: null });
    expect(decision.card?.destination).toBe('https://hooks.example.com/x');
  });

  it('extraction without a connector still reports an unverifiable carried send', () => {
    const result = extractCardFields({ tool_name: 'transmit_letter', canonical_params: { body: 'hi' } });
    expect(result.external_service).toBe(true);
    expect(result.destination_unverifiable).toBe(true);
  });
});
