import { ModelCatalog } from '../../../src/catalog/ModelCatalog';
import { DEFAULT_TOKEN_FACTORY_MODEL } from '../../../src/runtime/tokenFactoryDefaults';
import { envManagedDefaultModelName, tokenFactoryModelName } from '../../../src/runtime/tokenFactoryProvider';

// The catalog still lists this model so a person can pick it; the server no longer registers it by itself.
const NANO_MODEL = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

describe('shipped model catalog', () => {
  it('offers a Token Factory preset on the Nebius endpoint with the default and Nano models', () => {
    const preset = ModelCatalog.load()
      .list()
      .find(entry => entry.type === 'tokenfactory');

    expect(preset?.base_url).toBe('https://api.tokenfactory.nebius.com/v1');
    expect(preset?.models.map(model => model.model_id)).toEqual([DEFAULT_TOKEN_FACTORY_MODEL, NANO_MODEL]);
    expect(preset?.models.map(model => model.name)).toEqual([
      tokenFactoryModelName(DEFAULT_TOKEN_FACTORY_MODEL),
      tokenFactoryModelName(NANO_MODEL),
    ]);
  });

  it('gives the default Token Factory model an explicit output cap and its context length', () => {
    const preset = ModelCatalog.load()
      .list()
      .find(entry => entry.type === 'tokenfactory');
    const defaultModel = preset?.models.find(model => model.model_id === DEFAULT_TOKEN_FACTORY_MODEL);

    expect(defaultModel?.properties.max_output_tokens).toBe(32768);
    expect(defaultModel?.properties.context_length).toBe(262144);
  });

  it('lists the env-managed default model under the same name the preset gives it', () => {
    expect(envManagedDefaultModelName(DEFAULT_TOKEN_FACTORY_MODEL)).toBe('tokenfactory/nemotron-3-super-120b-a12b');
  });
});
