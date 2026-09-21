import { describe, expect, it } from 'vitest';

import { reconcileDraftSpecPreferences } from '@/atoms/draft/DraftSpecPreferenceBridge.js';
import type { AgentSpec, ModelSelection } from '@/server/types.js';

const qwen: ModelSelection = { id: 'qwen', name: 'gemma/qwen', provider: { name: 'gemma' }, properties: {} };
const claude: ModelSelection = {
  id: 'claude',
  name: 'anthropic/claude-3.7-sonnet',
  provider: { name: 'anthropic' },
  properties: { reasoningEfforts: ['low', 'medium', 'high'] },
};

describe('reconcileDraftSpecPreferences', () => {
  it('falls back to the first available model when the remembered model no longer exists', () => {
    const agentSpec: AgentSpec = { model: { name: 'local-llama/assistant-q-6' } };

    expect(
      reconcileDraftSpecPreferences({
        agentSpec,
        models: [qwen],
        skills: [],
        connectors: [],
        skillsEnabled: true,
      }),
    ).toEqual({ model: { name: 'gemma/qwen' } });
  });

  it('preserves other model params when falling back from a stale model id', () => {
    const agentSpec: AgentSpec = { model: { name: 'local-llama/assistant-q-6', params: { maxTokens: 512 } } };

    expect(
      reconcileDraftSpecPreferences({
        agentSpec,
        models: [claude],
        skills: [],
        connectors: [],
        skillsEnabled: true,
      }),
    ).toEqual({
      model: { name: 'anthropic/claude-3.7-sonnet', params: { maxTokens: 512, reasoningEffort: 'medium' } },
    });
  });

  it('falls back to the first available model when none is selected yet', () => {
    const agentSpec: AgentSpec = { model: { name: '' } };

    expect(
      reconcileDraftSpecPreferences({
        agentSpec,
        models: [qwen],
        skills: [],
        connectors: [],
        skillsEnabled: true,
      }),
    ).toEqual({ model: { name: 'gemma/qwen' } });
  });

  it('does not rewrite a selection that is still present in the catalog', () => {
    const agentSpec: AgentSpec = { model: { name: 'gemma/qwen' } };

    expect(
      reconcileDraftSpecPreferences({
        agentSpec,
        models: [qwen],
        skills: [],
        connectors: [],
        skillsEnabled: true,
      }),
    ).toEqual({});
  });
});
