import type { SessionAgent } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IAgentStore } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { SummarizeTurnContext } from './memory/memoryRetain';
import { resolveSummarizationModelFqn } from './memory/memorySummarize';
import type { TurnModelUsage } from './modelUsage';
import type { TokenFactoryBudget } from './tokenFactoryBudget';

/**
 * Global-settings key for the persisted turn-summarization override.
 * Stored values are the strings `'true'` / `'false'`; anything else reads as unset.
 */
export const MEMORY_SUMMARIZE_SETTING_KEY = 'memory_summarize_enabled';

export interface MemorySummarizeSetting {
  /** The stored setting: the persisted override when present, else the env default. */
  enabled: boolean;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The `MEMORY_SUMMARIZE` env default used when no override is stored. */
  defaultEnabled: boolean;
  /**
   * What the server will actually do for the next turn: the stored setting ANDed with
   * the markdown-only gate. This is the truth the Settings toggle shows — on any other
   * backend turns are retained verbatim even when `enabled` is true.
   */
  effectiveEnabled: boolean;
}

export interface ReadMemorySummarizeSettingDeps {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}

function parseOverride(value: string): boolean | undefined {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

/**
 * The markdown-only gate, owned here: summarization runs only on the markdown backend.
 * `beginTurnExecution` and the effective-state computation both go through this so the
 * Settings toggle can never disagree with what the turn path actually does.
 */
export function isMemorySummarizeEffective(enabled: boolean): boolean {
  return enabled && configuration.MEMORY_BACKEND === 'markdown';
}

/**
 * The turn-summarization stored setting: the persisted override when one is stored,
 * otherwise `MEMORY_SUMMARIZE`. A stored value that is not exactly `'true'`/`'false'`
 * is treated as unset. Fails closed to the env default when the store read throws, so
 * a settings-table outage can never silently flip summarization.
 *
 * The returned `enabled` is the stored setting (override else env default); `effectiveEnabled`
 * is what the server will actually do, with the markdown-only gate applied. See
 * `beginTurnExecution`.
 */
export async function readMemorySummarizeSetting(
  deps: ReadMemorySummarizeSettingDeps,
): Promise<MemorySummarizeSetting> {
  const defaultEnabled = configuration.MEMORY_SUMMARIZE;
  const unset: MemorySummarizeSetting = {
    enabled: defaultEnabled,
    overridden: false,
    defaultEnabled,
    effectiveEnabled: isMemorySummarizeEffective(defaultEnabled),
  };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_SUMMARIZE_SETTING_KEY });
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; using the env default for turn summarization',
      extractErrorLogFields(error),
    );
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  const override = parseOverride(record.value);
  if (override === undefined) {
    deps.logger.warn('Ignoring malformed turn-summarization override; using the env default', {
      value: record.value,
    });
    return unset;
  }
  return {
    enabled: override,
    overridden: true,
    defaultEnabled,
    effectiveEnabled: isMemorySummarizeEffective(override),
  };
}

/**
 * Effective on/off for turn construction: the stored setting. Unlike screening there is
 * no external service to AND in — summarization degrades to the verbatim transcript on
 * its own when the model call fails — so the stored value is the effective value. The
 * markdown-only gate stays in the turn path (`resolveTurnSummarizeContext`), which also logs why
 * a non-markdown backend retains turns verbatim.
 */
export async function resolveMemorySummarizeEnabled(deps: ReadMemorySummarizeSettingDeps): Promise<boolean> {
  const setting = await readMemorySummarizeSetting(deps);
  return setting.enabled;
}

export interface ResolveTurnSummarizeContextParams {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
  sessionId: string;
  tenantId: string;
  modelProviderStore: IModelProviderStore;
  tokenFactoryBudget: TokenFactoryBudget;
  modelUsage: TurnModelUsage;
  agentStore: IAgentStore;
  personaModelName: string | undefined;
  sessionAgent: SessionAgent;
  /**
   * Whether a memory client exists to consume the context. Without one the
   * agent-store read is skipped and the turn retains verbatim.
   */
  memoryClientPresent: boolean;
  /** The small model for helper jobs; see `routeHelperModel`. */
  helperFqn?: string | undefined;
}

/**
 * Resolves one turn's summarization context, shared by every turn-creation path (the chat
 * route and `beginTurnExecution`). Returns undefined when the turn must not summarize;
 * every such outcome is logged at debug so the effective state is observable instead of
 * silently falling back to the verbatim transcript.
 *
 * The model-FQN lookup costs one agent-store read and runs pre-turn, because the drain
 * input does not carry agentStore/sessionAgent. A lookup failure drops summarization for
 * this turn (verbatim fallback), never the turn.
 */
export async function resolveTurnSummarizeContext(
  params: ResolveTurnSummarizeContextParams,
): Promise<SummarizeTurnContext | undefined> {
  const {
    globalSettingsStore,
    logger,
    sessionId,
    tenantId,
    modelProviderStore,
    tokenFactoryBudget,
    modelUsage,
    agentStore,
    personaModelName,
    sessionAgent,
    memoryClientPresent,
    helperFqn,
  } = params;
  const enabled = await resolveMemorySummarizeEnabled({ globalSettingsStore, logger });
  if (!isMemorySummarizeEffective(enabled)) {
    if (enabled) {
      // Summarization is markdown-only; say so once per turn rather than failing silently.
      logger.debug(
        'Turn summarization is enabled but the memory backend is not markdown; turns will be retained verbatim',
        {
          sessionId,
          memoryBackend: configuration.MEMORY_BACKEND,
        },
      );
    } else {
      logger.debug('Turn summarization is off for this turn; retaining the verbatim transcript', {
        sessionId,
      });
    }
    return undefined;
  }
  if (!memoryClientPresent) {
    logger.debug('Turn summarization has no memory client for this turn; retaining the verbatim transcript', {
      sessionId,
    });
    return undefined;
  }
  try {
    const summarizationModelFqn = await resolveSummarizationModelFqn({
      tenantId,
      personaModelName,
      sessionAgent,
      agentStore,
      helperFqn,
    });
    if (summarizationModelFqn === undefined || summarizationModelFqn.trim() === '') {
      logger.debug(
        'Turn summarization is enabled but no summarization model resolved for this turn; retaining the verbatim transcript',
        { sessionId },
      );
      return undefined;
    }
    logger.debug('Turn summarization is active for this turn', { sessionId, summarizationModelFqn });
    return { tenantId, modelProviderStore, summarizationModelFqn, tokenFactoryBudget, modelUsage };
  } catch (error) {
    logger.debug('Memory summarization disabled for this turn: the model FQN did not resolve', {
      sessionId,
      ...extractErrorLogFields(error),
    });
    return undefined;
  }
}
