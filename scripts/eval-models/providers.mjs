// The model providers a throwaway eval instance is given, from packages/trueforge/evals/eval-providers.json.
// A provider is added only when its key is in the environment. The key goes to the instance and nowhere else.
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const PROVIDERS_VERSION = 1;
const NAME = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrice(value) {
  return (
    isRecord(value) &&
    typeof value.input_per_million === 'number' &&
    value.input_per_million >= 0 &&
    typeof value.output_per_million === 'number' &&
    value.output_per_million >= 0
  );
}

/**
 * @typedef {{ model_id: string, name: string, properties: Record<string, unknown>, price?: { input_per_million: number, output_per_million: number } }} EvalProviderModel
 * @typedef {{ name: string, base_url: string, api_key_env: string, models: EvalProviderModel[] }} EvalProvider
 */

/**
 * @param {unknown} value
 * @returns {EvalProvider[]}
 */
export function parseEvalProviders(value) {
  const problems = [];
  if (!isRecord(value) || value.version !== PROVIDERS_VERSION || !Array.isArray(value.providers)) {
    throw new Error(`eval-providers.json must have version ${String(PROVIDERS_VERSION)} and a providers list.`);
  }
  value.providers.forEach((provider, index) => {
    const where = `providers[${String(index)}]`;
    if (!isRecord(provider) || !NAME.test(provider.name ?? '')) {
      problems.push(`${where}.name must be lower-case letters, digits and hyphens`);
      return;
    }
    let url;
    try {
      url = new URL(provider.base_url);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:') {
      problems.push(`${where}.base_url must be an https address`);
    }
    if (!ENV_NAME.test(provider.api_key_env ?? '')) {
      problems.push(`${where}.api_key_env must name an environment variable, such as META_API_KEY`);
    }
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.length === 0) {
      problems.push(`${where}.models must list at least one model`);
    }
    models.forEach((model, modelIndex) => {
      const at = `${where}.models[${String(modelIndex)}]`;
      if (
        !isRecord(model) ||
        typeof model.model_id !== 'string' ||
        model.model_id === '' ||
        !NAME.test(model.name ?? '')
      ) {
        problems.push(`${at} needs a model_id and a name of lower-case letters, digits and hyphens`);
      } else if (!isRecord(model.properties ?? {}) || (model.price !== undefined && !isPrice(model.price))) {
        problems.push(`${at} has properties or a price in the wrong shape`);
      }
    });
  });
  if (problems.length > 0) {
    throw new Error(`eval-providers.json is not valid:\n- ${problems.join('\n- ')}`);
  }
  return value.providers.map(provider => ({
    name: provider.name,
    base_url: provider.base_url,
    api_key_env: provider.api_key_env,
    models: provider.models.map(model => ({
      model_id: model.model_id,
      name: model.name,
      properties: model.properties ?? {},
      ...(model.price === undefined ? {} : { price: model.price }),
    })),
  }));
}

/** @param {string} file */
export async function loadEvalProviders(file) {
  let json;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the eval providers at ${file}. Check that the file exists and is valid JSON.`, {
      cause: error,
    });
  }
  return parseEvalProviders(json);
}

/** Prices keyed by the model name the eval uses, `provider/model`. */
export function providerPrices(providers) {
  const prices = {};
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.price !== undefined) {
        prices[`${provider.name}/${model.name}`] = model.price;
      }
    }
  }
  return prices;
}

/**
 * Adds every provider whose key is set to the instance, through the settings API the app uses.
 * Returns the providers it added. Their keys are sent only in the request body to the instance.
 * @param {{ providers: EvalProvider[], env: Record<string, string | undefined>, origin: string, token: string, fetchImpl?: typeof fetch }} options
 */
export async function addEvalProviders({ providers, env, origin, token, fetchImpl = fetch }) {
  const added = [];
  for (const provider of providers) {
    const key = env[provider.api_key_env]?.trim();
    if (key === undefined || key === '') {
      continue;
    }
    const response = await fetchImpl(`${origin}/api/v1/settings/model-providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        manifest: {
          type: 'custom',
          name: provider.name,
          base_url: provider.base_url,
          auth: { api_key: key },
          models: provider.models.map(model => ({
            model_id: model.model_id,
            name: model.name,
            properties: model.properties,
          })),
        },
      }),
    });
    if (!response.ok) {
      throw new Error(
        `The eval instance did not accept the ${provider.name} provider (HTTP ${String(response.status)}). Check its entry in eval-providers.json.`,
      );
    }
    added.push(provider);
  }
  return added;
}
