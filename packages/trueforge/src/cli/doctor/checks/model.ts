import { TOKEN_FACTORY_DEFAULT_BASE_URL } from '@truefoundry/trueforge-core/core';

import { DEFAULT_TOKEN_FACTORY_MODEL } from '../../../runtime/tokenFactoryDefaults';
import type { SmokeCheck } from '../../../runtime/tokenFactorySmoke';
import type { DoctorDeps } from '../deps';
import { failCheck, offCheck, okCheck, type Check } from '../schemas';

function fixFor(failed: SmokeCheck): string {
  if (/^HTTP 40[13]\b/.test(failed.detail)) {
    return 'Token Factory refused the key. Create a new key in the Token Factory console, put it in NEBIUS_API_KEY in the instance .env file, then restart the instance.';
  }
  if (failed.label.startsWith('model listed')) {
    return 'Set TOKEN_FACTORY_MODEL in the instance .env file to a model id that Token Factory lists for your key, then restart the instance.';
  }
  if (failed.label.startsWith('tool call')) {
    return 'The model must support tool calls. Set TOKEN_FACTORY_MODEL in the instance .env file to a model that does, then restart the instance.';
  }
  return 'Check that this machine can reach Token Factory over https (port 443), then run doctor again.';
}

/** A blank setting means the server default, as in the server's own config. */
function settingOr({ value, fallback }: { value: string | undefined; fallback: string }): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? fallback : trimmed;
}

/**
 * The hosted model answers: the model list names the configured model and one tool-call request works.
 * The checks themselves have one owner, the live smoke test; this only reads the settings and words the result.
 */
export async function checkModel({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'model';
  const apiKey = deps.env['NEBIUS_API_KEY']?.trim();
  if (apiKey === undefined || apiKey === '') {
    return offCheck({
      id,
      detail: 'No Token Factory key is set (NEBIUS_API_KEY), so the hosted model is not checked.',
    });
  }
  const model = settingOr({ value: deps.env['TOKEN_FACTORY_MODEL'], fallback: DEFAULT_TOKEN_FACTORY_MODEL });
  const baseUrl = settingOr({ value: deps.env['TOKEN_FACTORY_BASE_URL'], fallback: TOKEN_FACTORY_DEFAULT_BASE_URL });
  const checks = await deps.tokenFactoryChecks({ apiKey, baseUrl, model, timeoutMs });
  const failed = checks.find(check => !check.ok);
  if (failed !== undefined) {
    return failCheck({
      id,
      detail: `Token Factory ${failed.label}: ${failed.detail}`,
      fix: fixFor(failed),
    });
  }
  return okCheck({ id, detail: `Token Factory lists ${model} and it answered a tool call.` });
}
