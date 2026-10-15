import { ModelCatalog } from '../../../src/catalog/ModelCatalog';
import { DEFAULT_TOKEN_FACTORY_CHEAPER_MODEL, DEFAULT_TOKEN_FACTORY_MODEL } from '../../../src/config';
import { envManagedDefaultModelName, tokenFactoryModelName } from '../../../src/runtime/tokenFactoryProvider';

describe('shipped model catalog', () => {
  it('offers a Token Factory preset on the Nebius endpoint with the default and cheaper models', () => {
    const preset = ModelCatalog.load()
      .list()
      .find(entry => entry.type === 'tokenfactory');

    expect(preset?.base_url).toBe('https://api.tokenfactory.nebius.com/v1');
    expect(preset?.models.map(model => model.model_id)).toEqual([
      DEFAULT_TOKEN_FACTORY_MODEL,
      DEFAULT_TOKEN_FACTORY_CHEAPER_MODEL,
    ]);
    expect(preset?.models.map(model => model.name)).toEqual([
      tokenFactoryModelName(DEFAULT_TOKEN_FACTORY_MODEL),
      tokenFactoryModelName(DEFAULT_TOKEN_FACTORY_CHEAPER_MODEL),
    ]);
  });

  it('lists the env-managed default model under the same name the preset gives it', () => {
    expect(envManagedDefaultModelName(DEFAULT_TOKEN_FACTORY_MODEL)).toBe('tokenfactory/nemotron-3-super-120b-a12b');
  });
});
