/**
 * Tests for resolveSummarizationModelFqn.
 *
 * Verifies that the summarization role's model is used when explicitly set,
 * and that it falls back through persona override → main model when unset.
 * For stored agents, the agent record must be fetched exactly once (single DB read).
 */
import { AgentSpecSchema, type SessionAgent, type SessionAgentInline } from '@truefoundry/trueforge-core/agent-session';
import { type AgentRecord, type IAgentStore } from '../../../../src/db/agentStore';
import { resolveSummarizationModelFqn } from '../../../../src/runtime/memory/memorySummarize';

function fakeAgentStore(): IAgentStore {
  return {
    listAgents: jest.fn(),
    getOwnedIds: jest.fn(),
    getExternalIdsByIds: jest.fn(),
    getAgent: jest.fn(),
    createAgent: jest.fn(),
    updateAgent: jest.fn(),
    deleteAgent: jest.fn(),
  };
}

function inlineAgent(summarizationModelName?: string): SessionAgentInline {
  const spec = AgentSpecSchema.parse({
    model: { name: 'openai/gpt-4o' },
    ...(summarizationModelName !== undefined
      ? { auxiliary_models: { summarization: { name: summarizationModelName } } }
      : {}),
  });
  return { type: 'inline', spec };
}

function referenceAgent(): SessionAgent {
  return { type: 'reference', id: 'agent-1', name: null };
}

function agentRecord(summarizationModelName?: string): AgentRecord {
  const manifest = AgentSpecSchema.parse({
    model: { name: 'openai/gpt-4o' },
    ...(summarizationModelName !== undefined
      ? { auxiliary_models: { summarization: { name: summarizationModelName } } }
      : {}),
  });
  return {
    id: 'agent-1',
    tenant_id: 'tenant-1',
    name: 'test-agent',
    description: 'Test agent',
    manifest,
    external_id: null,
    host_managed: false,
    created_by_subject: {
      subject_id: 'user-1',
      subject_type: 'user',
      subject_display_name: 'Test User',
    },
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  };
}

describe('resolveSummarizationModelFqn', () => {
  it('uses the summarization role model when set on an inline agent', async () => {
    const result = await resolveSummarizationModelFqn({
      tenantId: 'tenant-1',
      personaModelName: undefined,
      sessionAgent: inlineAgent('anthropic/claude-3-5-sonnet'),
      agentStore: fakeAgentStore(),
    });

    expect(result).toBe('anthropic/claude-3-5-sonnet');
  });

  it('falls back to the main model when the role is unset on an inline agent', async () => {
    const store = fakeAgentStore();
    const result = await resolveSummarizationModelFqn({
      tenantId: 'tenant-1',
      personaModelName: undefined,
      sessionAgent: inlineAgent(),
      agentStore: store,
    });

    expect(result).toBe('openai/gpt-4o');
    // Inline agents need no DB read.
    expect(store.getAgent).not.toHaveBeenCalled();
  });

  it('uses the summarization role model when set on a stored agent', async () => {
    const store = fakeAgentStore();
    const getAgent = jest.mocked(store.getAgent);
    getAgent.mockResolvedValue(agentRecord('google/gemini-2.0-flash'));

    const result = await resolveSummarizationModelFqn({
      tenantId: 'tenant-1',
      personaModelName: undefined,
      sessionAgent: referenceAgent(),
      agentStore: store,
    });

    expect(result).toBe('google/gemini-2.0-flash');
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it('falls back to the main model with a single DB read when the role is unset on a stored agent', async () => {
    const store = fakeAgentStore();
    const getAgent = jest.mocked(store.getAgent);
    getAgent.mockResolvedValue(agentRecord());

    const result = await resolveSummarizationModelFqn({
      tenantId: 'tenant-1',
      personaModelName: undefined,
      sessionAgent: referenceAgent(),
      agentStore: store,
    });

    expect(result).toBe('openai/gpt-4o');
    // Single DB read: the fetched record is reused for the fallback (no second getAgent).
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it('prefers the summarization role over the persona override', async () => {
    const result = await resolveSummarizationModelFqn({
      tenantId: 'tenant-1',
      personaModelName: 'openai/gpt-4o-mini',
      sessionAgent: inlineAgent('anthropic/claude-3-5-sonnet'),
      agentStore: fakeAgentStore(),
    });

    expect(result).toBe('anthropic/claude-3-5-sonnet');
  });

  it('uses the persona override when the role is unset', async () => {
    const store = fakeAgentStore();
    const result = await resolveSummarizationModelFqn({
      tenantId: 'tenant-1',
      personaModelName: 'openai/gpt-4o-mini',
      sessionAgent: inlineAgent(),
      agentStore: store,
    });

    expect(result).toBe('openai/gpt-4o-mini');
    expect(store.getAgent).not.toHaveBeenCalled();
  });

  describe('Token Factory main model', () => {
    it('uses the main model when the role is unset', async () => {
      const result = await resolveSummarizationModelFqn({
        tenantId: 'tenant-1',
        personaModelName: 'tokenfactory/nemotron-3-super-120b-a12b',
        sessionAgent: inlineAgent(),
        agentStore: fakeAgentStore(),
      });

      expect(result).toBe('tokenfactory/nemotron-3-super-120b-a12b');
    });

    it('keeps an explicitly chosen summarization model', async () => {
      const result = await resolveSummarizationModelFqn({
        tenantId: 'tenant-1',
        personaModelName: 'tokenfactory/nemotron-3-super-120b-a12b',
        sessionAgent: inlineAgent('tokenfactory/gpt-oss-120b'),
        agentStore: fakeAgentStore(),
      });

      expect(result).toBe('tokenfactory/gpt-oss-120b');
    });
  });
});
