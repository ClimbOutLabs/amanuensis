// @vitest-environment jsdom
import type { AgentSpec } from '@/server/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAgentUIServer } from './mockServer.js';

import {
  AGENT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY,
  CHAT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY,
  DRAFT_SPEC_PREFERENCES_STORAGE_KEY,
  readDraftSpecPreferences,
  selectAgentDraftSpecPreferences,
  selectChatDraftSpecPreferences,
  skillsHeldBack,
  withCapabilitiesSandbox,
  withoutSkillsWhenSandboxOff,
  withSendableSkills,
  writeDraftSpecPreferences,
} from '@/server/draftSpecPreferences.js';

describe('selectDraftSpecPreferences', () => {
  it('keeps only model, skills, and MCP for chat', () => {
    expect(
      selectChatDraftSpecPreferences({
        model: { name: 'm', params: { reasoningEffort: 'high' } },
        skills: [{ name: 's' }],
        mcpServers: [{ name: 'c' }],
        config: { sandbox: { enabled: true } },
        instructions: 'nope',
      }),
    ).toEqual({
      model: { name: 'm', params: { reasoningEffort: 'high' } },
      skills: [{ name: 's' }],
      mcpServers: [{ name: 'c' }],
    });
  });

  it('keeps runtime config for agent', () => {
    expect(
      selectAgentDraftSpecPreferences({
        model: { name: 'm' },
        config: { sandbox: { enabled: true } },
        instructions: 'nope',
      }),
    ).toEqual({
      model: { name: 'm' },
      config: { sandbox: { enabled: true } },
    });
  });

  it('drops hidden generation and runtime limits from the model for both kinds', () => {
    const spec = {
      model: {
        name: 'model',
        params: { maxTokens: 128, temperature: 0, topP: 1, reasoningEffort: 'high' },
      },
      config: {
        iterationLimit: 4,
        sandbox: { enabled: false, fileDownloads: false },
        contextManagement: { compaction: { enabled: false } },
      },
    };

    expect(selectChatDraftSpecPreferences(spec)).toEqual({
      model: { name: 'model', params: { reasoningEffort: 'high' } },
    });
    expect(selectAgentDraftSpecPreferences(spec)).toEqual({
      model: { name: 'model', params: { reasoningEffort: 'high' } },
      config: {
        iterationLimit: 4,
        sandbox: { enabled: false, fileDownloads: false },
        contextManagement: { compaction: { enabled: false } },
      },
    });
  });
});

describe('draft preference storage', () => {
  beforeEach(() => {
    window.localStorage.removeItem(DRAFT_SPEC_PREFERENCES_STORAGE_KEY);
    window.localStorage.removeItem(CHAT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY);
    window.localStorage.removeItem(AGENT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY);
  });

  it('stores chat and agent preferences separately', () => {
    writeDraftSpecPreferences('chat', {
      model: { name: 'chat/model' },
      config: { sandbox: { enabled: true } },
    });
    writeDraftSpecPreferences('agent', {
      model: { name: 'agent/model' },
      config: { sandbox: { enabled: true } },
    });

    expect(readDraftSpecPreferences('chat')).toEqual({ model: { name: 'chat/model' } });
    expect(readDraftSpecPreferences('agent')).toEqual({
      model: { name: 'agent/model' },
      config: { sandbox: { enabled: true } },
    });
  });

  it('migrates the legacy shared key into both stores', () => {
    window.localStorage.setItem(
      DRAFT_SPEC_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        spec: {
          model: { name: 'legacy/model' },
          skills: [{ name: 'Skill' }],
          config: { sandbox: { enabled: true } },
        },
      }),
    );

    expect(readDraftSpecPreferences('chat')).toEqual({
      model: { name: 'legacy/model' },
      skills: [{ name: 'Skill' }],
    });
    expect(readDraftSpecPreferences('agent')).toEqual({
      model: { name: 'legacy/model' },
      skills: [{ name: 'Skill' }],
      config: { sandbox: { enabled: true } },
    });
    expect(window.localStorage.getItem(DRAFT_SPEC_PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it('keeps the legacy key when a destination write fails', () => {
    window.localStorage.setItem(
      DRAFT_SPEC_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        spec: {
          model: { name: 'legacy/model' },
          config: { sandbox: { enabled: true } },
        },
      }),
    );

    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === AGENT_DRAFT_SPEC_PREFERENCES_STORAGE_KEY) {
        throw new Error('quota exceeded');
      }
      return originalSetItem.call(this, key, value);
    });

    expect(readDraftSpecPreferences('chat')).toEqual({ model: { name: 'legacy/model' } });
    expect(readDraftSpecPreferences('agent')).toBeNull();
    expect(window.localStorage.getItem(DRAFT_SPEC_PREFERENCES_STORAGE_KEY)).not.toBeNull();

    setItemSpy.mockRestore();
    expect(readDraftSpecPreferences('agent')).toEqual({
      model: { name: 'legacy/model' },
      config: { sandbox: { enabled: true } },
    });
    expect(window.localStorage.getItem(DRAFT_SPEC_PREFERENCES_STORAGE_KEY)).toBeNull();
  });
});

describe('withCapabilitiesSandbox', () => {
  it('does not enable sandbox merely because it is available', () => {
    expect(withCapabilitiesSandbox({ model: { name: 'model' } }, true)).toEqual({
      model: { name: 'model' },
    });
  });

  it('preserves other runtime config', () => {
    expect(
      withCapabilitiesSandbox(
        {
          model: { name: 'model' },
          config: { askUserQuestions: { enabled: false } },
        },
        true,
      ),
    ).toEqual({
      model: { name: 'model' },
      config: {
        askUserQuestions: { enabled: false },
      },
    });
  });

  it('disables a spec-owned sandbox when it is unavailable', () => {
    expect(
      withCapabilitiesSandbox({ model: { name: 'model' }, config: { sandbox: { enabled: true } } }, false),
    ).toEqual({
      model: { name: 'model' },
      config: { sandbox: { enabled: false } },
    });
  });

  it('preserves the spec sandbox while capabilities are unavailable', () => {
    const spec = { model: { name: 'model' }, config: { sandbox: { enabled: true } } };

    expect(withCapabilitiesSandbox(spec, undefined)).toBe(spec);
    expect(withCapabilitiesSandbox(spec, null)).toBe(spec);
  });

  it('returns the same spec when sandbox already matches capabilities', () => {
    const spec = { model: { name: 'model' }, config: { sandbox: { enabled: false } } };

    expect(withCapabilitiesSandbox(spec, false)).toBe(spec);
  });
});

describe('withoutSkillsWhenSandboxOff', () => {
  const skills = [{ name: 'find-skills' }];
  const sandboxOn = { model: { name: 'model' }, skills, config: { sandbox: { enabled: true } } };
  const sandboxOff = { model: { name: 'model' }, skills, config: { sandbox: { enabled: false } } };

  it('sends no skills while the sandbox is unavailable', () => {
    expect(withoutSkillsWhenSandboxOff(sandboxOn, false)).toEqual({
      model: { name: 'model' },
      config: { sandbox: { enabled: true } },
    });
    expect(skillsHeldBack(sandboxOn, false)).toBe('sandbox_unavailable');
  });

  it('sends no skills when the sandbox is available but off for this spec', () => {
    expect(withoutSkillsWhenSandboxOff(sandboxOff, true)).toEqual({
      model: { name: 'model' },
      config: { sandbox: { enabled: false } },
    });
    expect(skillsHeldBack(sandboxOff, true)).toBe('sandbox_turned_off');
  });

  it('keeps skills when the sandbox is available and on', () => {
    expect(withoutSkillsWhenSandboxOff(sandboxOn, true)).toBe(sandboxOn);
    expect(skillsHeldBack(sandboxOn, true)).toBeNull();
  });

  it('leaves a spec without skills as it is', () => {
    const plain = { model: { name: 'model' }, config: { sandbox: { enabled: false } } };

    expect(withoutSkillsWhenSandboxOff(plain, false)).toBe(plain);
    expect(skillsHeldBack(plain, false)).toBeNull();
  });

  it('keeps the stored choice when the sandbox goes off and on again', () => {
    window.localStorage.clear();
    writeDraftSpecPreferences('chat', sandboxOn);
    withoutSkillsWhenSandboxOff(sandboxOn, false);
    writeDraftSpecPreferences('chat', sandboxOn);
    expect(readDraftSpecPreferences('chat')?.skills).toEqual(skills);
    expect(withoutSkillsWhenSandboxOff(sandboxOn, true).skills).toEqual(skills);
  });
});

describe('withSendableSkills', () => {
  const spec = { model: { name: 'model' }, skills: [{ name: 'find-skills' }], config: { sandbox: { enabled: true } } };

  it('sends no skills in a new session or an update while the sandbox is unavailable', async () => {
    const session = { id: 's', isMutable: true, createdAt: 'now', updatedAt: 'now' };
    const sent: Array<AgentSpec | undefined> = [];
    const server = withSendableSkills({
      server: createMockAgentUIServer({
        createSession: async request => {
          sent.push(request.agentSpec);
          return session;
        },
        updateSession: async request => {
          sent.push(request.agentSpec);
          return session;
        },
      }),
      sandboxEnabled: false,
    });

    await server.createSession({ agentSpec: spec });
    await server.updateSession({ sessionId: 's', agentSpec: spec });

    expect(sent.map(sentSpec => sentSpec?.skills)).toEqual([undefined, undefined]);
  });
});
