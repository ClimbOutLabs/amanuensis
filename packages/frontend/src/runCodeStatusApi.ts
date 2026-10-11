import { RunCodeStatusSchema } from '@truefoundry/trueforge-core/core/sandbox/driver/RunCodeSchemas';
import type { RunCodeStatusApi } from '@truefoundry/trueforge-ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return `Request failed (${String(status)}).`;
}

export function createRunCodeStatusApi(fetcher: typeof fetch): RunCodeStatusApi {
  return {
    async getRunCodeStatus() {
      const response = await fetcher('/api/v1/settings/run-code/status');
      const body: unknown = await response.json().catch((): null => null);
      if (!response.ok) {
        throw new Error(errorMessage({ body, status: response.status }));
      }
      const parsed = RunCodeStatusSchema.safeParse(isRecord(body) ? body.data : undefined);
      if (!parsed.success) {
        throw new Error('The sandbox status response was invalid.', { cause: parsed.error });
      }
      return parsed.data;
    },
  };
}
