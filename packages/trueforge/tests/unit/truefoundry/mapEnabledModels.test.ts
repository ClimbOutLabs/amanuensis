import { createLogger } from 'winston';
import { mapEnabledModels } from '../../../src/truefoundry/mapEnabledModels';

function integration(name: string, limits: Record<string, number>) {
  return {
    name,
    manifest: { model_types: ['chat'] },
    providerAccount: { name: 'acme' },
    metadata: { limits },
  };
}

describe('mapEnabledModels token limits', () => {
  it('keeps models whose provider-reported limits leave room for input', () => {
    const logger = createLogger({ silent: true });
    const warn = jest.spyOn(logger, 'warn');
    const models = mapEnabledModels({
      integrations: [integration('ok', { context_window: 128000, max_output_tokens: 4096 })],
      logger,
    });
    expect(models.map(model => model.modelName)).toEqual(['ok']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a model whose max output plus the safety reserve reaches the context window, and warns', () => {
    const logger = createLogger({ silent: true });
    const warn = jest.spyOn(logger, 'warn');
    const models = mapEnabledModels({
      integrations: [
        integration('bad', { context_window: 8000, max_output_tokens: 7600 }),
        integration('bad-max-tokens', { max_input_tokens: 8000, max_tokens: 8000 }),
        integration('ok', { context_window: 128000, max_output_tokens: 4096 }),
      ],
      logger,
    });
    expect(models.map(model => model.modelName)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('Skipping TrueFoundry model with unusable token limits', {
      provider_account: 'acme',
      model: 'bad',
      context_length: 8000,
      max_output_tokens: 7600,
    });
  });
});
