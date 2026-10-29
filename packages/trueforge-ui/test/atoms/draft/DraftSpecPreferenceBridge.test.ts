import { beforeEach, describe, expect, it } from 'vitest';

import {
  messageAsksForSandbox,
  reconcileDraftSandbox,
  reconcileDraftSpecMounts,
  reconcileDraftSpecPreferences,
} from '@/atoms/draft/DraftSpecPreferenceBridge.js';
import {
  CHAT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY,
  readDraftSpecPreferences,
  writeDraftSpecPreferences,
} from '@/server/draftSpecPreferences.js';
import type { AgentSpec, ConnectorState, ModelSelection } from '@/server/types.js';

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

describe('reconcileDraftSpecMounts', () => {
  const tavily: ConnectorState = { id: 'tavily', name: 'tavily', authenticated: true };
  const github: ConnectorState = { id: 'github', name: 'github', authenticated: true };

  it('drops a mount for a connector that is not configured and keeps the configured ones', () => {
    const agentSpec: AgentSpec = {
      model: { name: 'gemma/qwen' },
      mcpServers: [{ name: 'parallel-web' }, { name: 'tavily' }, { name: 'github' }],
    };

    expect(reconcileDraftSpecMounts({ agentSpec, connectors: [tavily, github] })).toEqual({
      mcpServers: [{ name: 'tavily' }, { name: 'github' }],
    });
  });

  it('changes nothing when every mount is configured', () => {
    const agentSpec: AgentSpec = {
      model: { name: 'gemma/qwen' },
      mcpServers: [{ name: 'tavily' }],
    };

    expect(reconcileDraftSpecMounts({ agentSpec, connectors: [tavily] })).toEqual({});
  });

  it('changes nothing when the spec mounts no connectors', () => {
    const agentSpec: AgentSpec = { model: { name: 'gemma/qwen' } };

    expect(reconcileDraftSpecMounts({ agentSpec, connectors: [tavily] })).toEqual({});
  });
});

describe('a stored chat draft seed naming a deleted connector', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CHAT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY);
  });

  it('produces a new-chat spec without that mount, and keeps configured mounts', () => {
    writeDraftSpecPreferences('chat', {
      model: { name: 'gemma/qwen' },
      mcpServers: [{ name: 'parallel-web' }, { name: 'tavily' }],
    });

    const seed = readDraftSpecPreferences('chat');
    expect(seed).not.toBeNull();
    if (seed === null) return;
    const update = reconcileDraftSpecMounts({
      agentSpec: seed,
      connectors: [{ id: 'tavily', name: 'tavily', authenticated: true }],
    });
    const newChatSpec: AgentSpec = { ...seed, ...update };

    expect(newChatSpec.mcpServers).toEqual([{ name: 'tavily' }]);
  });
});

describe('reconcileDraftSandbox for a new chat', () => {
  const skills = [{ name: 'find-skills' }];

  it('turns the sandbox off when it is not available and does not touch the skills', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, skills, config: { sandbox: { enabled: true } } };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: false, kind: 'chat' })).toEqual({
      config: { sandbox: { enabled: false } },
    });
  });

  it('turns the sandbox on when it is available, the draft has skills and no setting', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, skills };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: true, kind: 'chat' })).toEqual({
      config: { sandbox: { enabled: true } },
    });
  });

  it('does not turn the sandbox on for a draft without skills', () => {
    expect(reconcileDraftSandbox({ agentSpec: { model: { name: 'm' } }, sandboxEnabled: true, kind: 'chat' })).toEqual(
      {},
    );
  });

  it('keeps an explicit off when the sandbox is available', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, skills, config: { sandbox: { enabled: false } } };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: true, kind: 'chat' })).toEqual({});
  });

  it('changes nothing when the sandbox is not available and the draft has no setting', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, skills };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: false, kind: 'chat' })).toEqual({});
  });

  it('does not seed the agent builder', () => {
    expect(
      reconcileDraftSandbox({ agentSpec: { model: { name: 'm' }, skills }, sandboxEnabled: true, kind: 'agent' }),
    ).toEqual({});
  });

  it('changes nothing when the sandbox is available', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, skills, config: { sandbox: { enabled: true } } };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: true, kind: 'chat' })).toEqual({});
  });

  it('changes nothing when the person turned the sandbox off and has no skills', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, config: { sandbox: { enabled: false } } };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: false, kind: 'chat' })).toEqual({});
  });
  it('turns the sandbox on for a draft without skills whose message asks to clone a repository', () => {
    expect(
      reconcileDraftSandbox({
        agentSpec: { model: { name: 'm' } },
        sandboxEnabled: true,
        kind: 'chat',
        asksForSandbox: true,
      }),
    ).toEqual({ config: { sandbox: { enabled: true } } });
  });

  it('keeps an explicit off even when the message asks to clone a repository', () => {
    const agentSpec: AgentSpec = { model: { name: 'm' }, config: { sandbox: { enabled: false } } };

    expect(reconcileDraftSandbox({ agentSpec, sandboxEnabled: true, kind: 'chat', asksForSandbox: true })).toEqual({});
  });

  it('does not turn the sandbox on for a clone request when the server has none', () => {
    expect(
      reconcileDraftSandbox({
        agentSpec: { model: { name: 'm' } },
        sandboxEnabled: false,
        kind: 'chat',
        asksForSandbox: true,
      }),
    ).toEqual({});
  });
});

describe('messageAsksForSandbox', () => {
  it('finds a request to clone a repository or run a command', () => {
    expect(
      messageAsksForSandbox(
        'Clone https://github.com/ClimbOutLabs/exitramp.git into a new folder named exitramp in the workspace, then check out the main branch.',
      ),
    ).toBe(true);
    expect(messageAsksForSandbox('Run this: git clone --branch main https://example.org/x.git x')).toBe(true);
    expect(messageAsksForSandbox('Please run this command in the shell: ls -la')).toBe(true);
  });

  it('leaves ordinary messages alone', () => {
    expect(messageAsksForSandbox('What is the weather in Paris?')).toBe(false);
    expect(messageAsksForSandbox('Summarize my last three emails. Then clone the style for a reply.')).toBe(false);
  });
});
