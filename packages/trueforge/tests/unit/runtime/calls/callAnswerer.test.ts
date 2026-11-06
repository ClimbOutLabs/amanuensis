import type { LLMCreateParams } from '@truefoundry/trueforge-core/core';
import winston from 'winston';

import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteModelProviderStore } from '../../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteTokenFactoryUsageStore } from '../../../../src/db/sqlite/token-factory-usage-store/SqliteTokenFactoryUsageStore';
import { createCallAnswerer } from '../../../../src/runtime/calls/callAnswerer';
import { resolveDefaultChatModel } from '../../../../src/runtime/defaultChatModel';
import { askModelOnce } from '../../../../src/runtime/oneShotModelCall';
import { createTokenFactoryBudget } from '../../../../src/runtime/tokenFactoryBudget';

jest.mock('../../../../src/runtime/defaultChatModel');
jest.mock('../../../../src/runtime/oneShotModelCall');

function answerer() {
  // The stores are never read: choosing the model and calling it are both replaced.
  const db = createSqliteDb(':memory:');
  return createCallAnswerer({
    tenantId: 'default',
    modelProviderStore: new SqliteModelProviderStore(db),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    tokenFactoryBudget: createTokenFactoryBudget({ store: new SqliteTokenFactoryUsageStore(db), cap: undefined }),
    logger: winston.createLogger({ silent: true }),
  });
}

describe('the model that answers on a call', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('is missing when the server has no model', async () => {
    jest.mocked(resolveDefaultChatModel).mockResolvedValueOnce(undefined);
    await expect(answerer()).resolves.toBeUndefined();
    expect(jest.mocked(askModelOnce)).not.toHaveBeenCalled();
  });

  it('answers once per reply on the model a new chat starts on, briefly, in time, and with no tools', async () => {
    jest.mocked(resolveDefaultChatModel).mockResolvedValueOnce('provider/model');
    jest.mocked(askModelOnce).mockResolvedValueOnce('Your pickup is at three.');
    const ask = await answerer();
    const signal = new AbortController().signal;
    const messages: LLMCreateParams['messages'] = [{ role: 'user', content: 'When is it?' }];
    await expect(ask?.({ messages, signal })).resolves.toBe('Your pickup is at three.');
    expect(jest.mocked(askModelOnce)).toHaveBeenCalledTimes(1);
    const [request] = jest.mocked(askModelOnce).mock.calls[0] ?? [];
    expect(request).toEqual(
      expect.objectContaining({
        tenantId: 'default',
        modelName: 'provider/model',
        role: 'chat',
        messages,
        maxTokens: 300,
        timeoutMs: 20_000,
        signal,
      }),
    );
    expect(request).not.toHaveProperty('tools');
  });
});
