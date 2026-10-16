/**
 * Live smoke test against the real Token Factory endpoint (`pnpm smoke:tokenfactory`).
 * Needs `NEBIUS_API_KEY`; without it the run is skipped. Not part of CI: it spends a few tokens.
 */
import configuration from '../src/config';
import { formatSmokeLine, runTokenFactorySmoke } from '../src/runtime/tokenFactorySmoke';

const { NEBIUS_API_KEY: apiKey, TOKEN_FACTORY_BASE_URL: baseUrl, TOKEN_FACTORY_MODEL: model } = configuration;

if (apiKey === undefined || apiKey.trim() === '') {
  console.log('skip NEBIUS_API_KEY is not set, so no request was made');
  process.exit(0);
}

const models = [model, configuration.TOKEN_FACTORY_CHEAPER_MODEL].filter(
  (id, index, all): id is string => id !== undefined && all.indexOf(id) === index,
);
const checks = await runTokenFactorySmoke({ apiKey, baseUrl, models });
for (const check of checks) {
  console.log(formatSmokeLine(check));
}
const failed = checks.filter(check => !check.ok).length;
console.log(
  failed === 0
    ? `ok   all ${String(checks.length)} checks passed`
    : `fail ${String(failed)} of ${String(checks.length)} checks failed`,
);
process.exit(failed === 0 ? 0 : 1);
