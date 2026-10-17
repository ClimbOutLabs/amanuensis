/**
 * Effective turn-summarization state: persisted override when stored,
 * otherwise the `MEMORY_SUMMARIZE` env default — with the markdown-only gate
 * applied, so the Settings toggle can never disagree with the turn path.
 */
import { AgentSpecSchema, type SessionAgent } from '@truefoundry/trueforge-core/agent-session';
import { Writable } from 'stream';
import { createLogger, format, transports, type Logger } from 'winston';

import configuration from '../../../src/config';
import type { AgentRecord, IAgentStore } from '../../../src/db/agentStore';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import type { IModelProviderStore } from '../../../src/db/modelProviderStore';
import {
  MEMORY_SUMMARIZE_SETTING_KEY,
  isMemorySummarizeEffective,
  readMemorySummarizeSetting,
  resolveMemorySummarizeEnabled,
  resolveTurnSummarizeContext,
} from '../../../src/runtime/memorySummarizeSettings';
import { discardedModelUsage } from '../../fixtures/discardedModelUsage';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const silentLogger = createLogger({ silent: true });

/** Winston logger that captures every emitted line for observability assertions. */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({
    level: 'debug',
    format: format.json(),
    transports: [new transports.Stream({ stream })],
  });
  return { logger, lines };
}

function inlineAgent(summarizationModelName?: string): SessionAgent {
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

function fakeModelProviderStore(): IModelProviderStore {
  return {
    listProviders: jest.fn(),
    getProvider: jest.fn(),
    getProviderForUpdate: jest.fn(),
    createProvider: jest.fn(),
    upsertProvider: jest.fn(),
    listModels: jest.fn(),
    deleteProvider: jest.fn(),
  };
}

function agentRecord(): AgentRecord {
  return {
    id: 'agent-1',
    tenant_id: 'tenant-1',
    name: 'test-agent',
    description: 'Test agent',
    manifest: AgentSpecSchema.parse({ model: { name: 'openai/gpt-4o' } }),
    external_id: null,
    created_by_subject: {
      subject_id: 'user-1',
      subject_type: 'user',
      subject_display_name: 'Test User',
    },
    created_at: '2026-09-21T00:00:00.000Z',
    updated_at: '2026-09-21T00:00:00.000Z',
  };
}

function record(value: string): GlobalSettingRecord {
  return { key: MEMORY_SUMMARIZE_SETTING_KEY, value, updated_at: '2026-09-21T00:00:00.000Z' };
}

function storeWith(values: Map<string, GlobalSettingRecord>): IGlobalSettingsStore {
  return {
    getSetting: async input => values.get(input.key),
    setSetting: async input => {
      const row = record(input.value);
      values.set(input.key, row);
      return row;
    },
    deleteSetting: async input => {
      values.delete(input.key);
    },
  };
}

function emptyStore(): IGlobalSettingsStore {
  return storeWith(new Map());
}

describe('readMemorySummarizeSetting', () => {
  const originalDefault = configuration.MEMORY_SUMMARIZE;
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_BACKEND = 'markdown';
  });

  afterEach(() => {
    configuration.MEMORY_SUMMARIZE = originalDefault;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('falls back to the env default when nothing is stored', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: emptyStore(), logger: silentLogger });
    expect(setting).toEqual({ enabled: false, overridden: false, defaultEnabled: false, effectiveEnabled: false });
  });

  it('falls back to an env default of true when nothing is stored', async () => {
    configuration.MEMORY_SUMMARIZE = true;
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: emptyStore(), logger: silentLogger });
    expect(setting).toEqual({ enabled: true, overridden: false, defaultEnabled: true, effectiveEnabled: true });
  });

  it('returns the stored true override over an env default of false', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('true')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({ enabled: true, overridden: true, defaultEnabled: false, effectiveEnabled: true });
  });

  it('returns the stored false override over an env default of true', async () => {
    configuration.MEMORY_SUMMARIZE = true;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('false')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({ enabled: false, overridden: true, defaultEnabled: true, effectiveEnabled: false });
  });

  it('treats a malformed stored value as unset', async () => {
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('TRUE')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.MEMORY_SUMMARIZE);
    expect(setting.effectiveEnabled).toBe(isMemorySummarizeEffective(configuration.MEMORY_SUMMARIZE));
  });

  it('fails closed to the env default when the store read throws', async () => {
    const failing: IGlobalSettingsStore = {
      getSetting: async () => {
        throw new Error('db down');
      },
      setSetting: async () => {
        throw new Error('db down');
      },
      deleteSetting: async () => {},
    };
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: failing, logger: silentLogger });
    expect(setting.overridden).toBe(false);
    expect(setting.enabled).toBe(configuration.MEMORY_SUMMARIZE);
  });

  it('reports effective false on a non-markdown backend even when the stored setting is on', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    configuration.MEMORY_SUMMARIZE = true;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('true')]]));
    const setting = await readMemorySummarizeSetting({ globalSettingsStore: store, logger: silentLogger });
    expect(setting).toEqual({ enabled: true, overridden: true, defaultEnabled: true, effectiveEnabled: false });
  });

  it('resolveMemorySummarizeEnabled returns the stored setting verbatim (no external gate)', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const store = storeWith(new Map([[MEMORY_SUMMARIZE_SETTING_KEY, record('true')]]));
    await expect(resolveMemorySummarizeEnabled({ globalSettingsStore: store, logger: silentLogger })).resolves.toBe(
      true,
    );
    await expect(
      resolveMemorySummarizeEnabled({ globalSettingsStore: emptyStore(), logger: silentLogger }),
    ).resolves.toBe(false);
  });
});

describe('isMemorySummarizeEffective', () => {
  const originalBackend = configuration.MEMORY_BACKEND;

  afterEach(() => {
    configuration.MEMORY_BACKEND = originalBackend;
  });

  it('is the stored value on the markdown backend', () => {
    configuration.MEMORY_BACKEND = 'markdown';
    expect(isMemorySummarizeEffective(true)).toBe(true);
    expect(isMemorySummarizeEffective(false)).toBe(false);
  });

  it('is always false on any other backend', () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    expect(isMemorySummarizeEffective(true)).toBe(false);
    expect(isMemorySummarizeEffective(false)).toBe(false);
  });
});

describe('resolveTurnSummarizeContext', () => {
  const originalDefault = configuration.MEMORY_SUMMARIZE;
  const originalBackend = configuration.MEMORY_BACKEND;

  beforeEach(() => {
    configuration.MEMORY_SUMMARIZE = true;
    configuration.MEMORY_BACKEND = 'markdown';
  });

  afterEach(() => {
    configuration.MEMORY_SUMMARIZE = originalDefault;
    configuration.MEMORY_BACKEND = originalBackend;
  });

  function baseParams(
    overrides: {
      logger?: Logger;
      sessionAgent?: SessionAgent;
      agentStore?: IAgentStore;
      memoryClientPresent?: boolean;
    } = {},
  ) {
    return {
      globalSettingsStore: emptyStore(),
      logger: overrides.logger ?? silentLogger,
      sessionId: 's1',
      tenantId: 'tenant-1',
      modelProviderStore: fakeModelProviderStore(),
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      modelUsage: discardedModelUsage,
      agentStore: overrides.agentStore ?? fakeAgentStore(),
      personaModelName: undefined,
      sessionAgent: overrides.sessionAgent ?? inlineAgent(),
      memoryClientPresent: overrides.memoryClientPresent ?? true,
    };
  }

  function logged(lines: string[], fragment: string): boolean {
    return lines.some(line => line.includes(fragment));
  }

  it('returns the context with the resolved model FQN when summarization is on', async () => {
    const { logger, lines } = capturingLogger();
    const modelProviderStore = fakeModelProviderStore();
    const context = await resolveTurnSummarizeContext({
      ...baseParams({ logger }),
      modelProviderStore,
    });

    expect(context).toEqual({
      tenantId: 'tenant-1',
      modelProviderStore,
      summarizationModelFqn: 'openai/gpt-4o',
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      modelUsage: discardedModelUsage,
    });
    expect(logged(lines, 'Turn summarization is active for this turn')).toBe(true);
  });

  it('returns undefined and logs when the toggle is off', async () => {
    configuration.MEMORY_SUMMARIZE = false;
    const { logger, lines } = capturingLogger();
    const agentStore = fakeAgentStore();

    const context = await resolveTurnSummarizeContext({ ...baseParams({ logger, agentStore }) });

    expect(context).toBeUndefined();
    expect(jest.mocked(agentStore.getAgent)).not.toHaveBeenCalled();
    expect(logged(lines, 'Turn summarization is off for this turn')).toBe(true);
  });

  it('returns undefined and logs when the backend is not markdown', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    const { logger, lines } = capturingLogger();
    const agentStore = fakeAgentStore();

    const context = await resolveTurnSummarizeContext({ ...baseParams({ logger, agentStore }) });

    expect(context).toBeUndefined();
    expect(jest.mocked(agentStore.getAgent)).not.toHaveBeenCalled();
    expect(logged(lines, 'not markdown')).toBe(true);
  });

  it('returns undefined and logs when no summarization model resolves', async () => {
    const { logger, lines } = capturingLogger();
    const agentStore = fakeAgentStore();
    jest.mocked(agentStore.getAgent).mockResolvedValue(undefined);

    // Reference agent with no registry record and no persona override: the
    // previously-silent path that stored verbatim while the toggle claimed on.
    const context = await resolveTurnSummarizeContext({
      ...baseParams({ logger, agentStore, sessionAgent: referenceAgent() }),
    });

    expect(context).toBeUndefined();
    expect(logged(lines, 'no summarization model resolved')).toBe(true);
  });

  it('returns undefined and logs when the model-FQN lookup throws', async () => {
    const { logger, lines } = capturingLogger();
    const agentStore = fakeAgentStore();
    jest.mocked(agentStore.getAgent).mockRejectedValue(new Error('db down'));

    const context = await resolveTurnSummarizeContext({
      ...baseParams({ logger, agentStore, sessionAgent: referenceAgent() }),
    });

    expect(context).toBeUndefined();
    expect(logged(lines, 'model FQN did not resolve')).toBe(true);
  });

  it('returns undefined and logs when no memory client is present', async () => {
    const { logger, lines } = capturingLogger();
    const agentStore = fakeAgentStore();

    const context = await resolveTurnSummarizeContext({
      ...baseParams({ logger, agentStore, memoryClientPresent: false }),
    });

    expect(context).toBeUndefined();
    expect(jest.mocked(agentStore.getAgent)).not.toHaveBeenCalled();
    expect(logged(lines, 'no memory client')).toBe(true);
  });

  it('prefers the persona model over the session agent model', async () => {
    const { logger } = capturingLogger();
    const context = await resolveTurnSummarizeContext({
      ...baseParams({ logger }),
      personaModelName: 'anthropic/claude-opus-4-6',
    });

    expect(context?.summarizationModelFqn).toBe('anthropic/claude-opus-4-6');
  });

  it('resolves the reference agent record exactly once for the FQN', async () => {
    const agentStore = fakeAgentStore();
    jest.mocked(agentStore.getAgent).mockResolvedValue(agentRecord());

    const context = await resolveTurnSummarizeContext({
      ...baseParams({ agentStore, sessionAgent: referenceAgent() }),
    });

    expect(context?.summarizationModelFqn).toBe('openai/gpt-4o');
    expect(jest.mocked(agentStore.getAgent)).toHaveBeenCalledTimes(1);
  });
});
