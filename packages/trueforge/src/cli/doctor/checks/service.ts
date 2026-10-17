import type { DoctorDeps } from '../deps';
import { describeNetworkError } from '../redact';
import { failCheck, okCheck, type Check } from '../schemas';

const DEFAULT_APP_PORT = '8790';

export async function checkService({ deps, timeoutMs }: { deps: DoctorDeps; timeoutMs: number }): Promise<Check> {
  const id = 'service';
  const configuredPort = deps.env['PORT']?.trim();
  const port = configuredPort === undefined || configuredPort === '' ? DEFAULT_APP_PORT : configuredPort;
  if (!/^\d{1,5}$/.test(port)) {
    return failCheck({
      id,
      detail: 'The app port setting is not a number.',
      fix: 'Set PORT in the instance .env file to a number between 1 and 65535, then restart the instance.',
    });
  }
  try {
    const response = await deps.get({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs });
    if (response.status === 200) {
      return okCheck({ id, detail: 'The app answers its health check.' });
    }
    return failCheck({
      id,
      detail: `The app health check returned status ${String(response.status)}.`,
      fix: 'Run aman doctor instance --fix',
    });
  } catch (error) {
    return failCheck({
      id,
      detail: `The app did not answer its health check (${describeNetworkError(error)}).`,
      fix: 'The app may still be starting. Wait a minute and run aman doctor again; if it stays down, run aman doctor instance --fix.',
    });
  }
}
