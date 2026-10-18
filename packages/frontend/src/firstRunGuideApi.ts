import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

const FIRST_RUN_GUIDE_URL = '/api/v1/settings/first-run-guide';

/** The first-run checklist's dismissal, kept on the server so it follows the owner across browsers. */
export interface FirstRunGuideApi {
  /** Whether the owner has put the checklist away. */
  getDismissed: () => Promise<boolean>;
  /** Records the choice; resolves with what the server now holds. */
  setDismissed: (dismissed: boolean) => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestError(value: unknown): value is TrueForgeApi.RequestErrorResponseError {
  return isRecord(value) && typeof value.message === 'string' && value.message !== '';
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRequestError(body.error)) {
    return body.error.message;
  }
  return `Request failed (${String(status)}).`;
}

async function readDismissed(response: Response): Promise<boolean> {
  const body: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    throw new Error(errorMessage({ body, status: response.status }));
  }
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || typeof data.dismissed !== 'boolean') {
    throw new Error('The first-run guide response was invalid.');
  }
  return data.dismissed;
}

export function createFirstRunGuideApi(fetcher: typeof fetch): FirstRunGuideApi {
  return {
    async getDismissed() {
      return await readDismissed(await fetcher(FIRST_RUN_GUIDE_URL));
    },
    async setDismissed(dismissed) {
      return await readDismissed(
        await fetcher(FIRST_RUN_GUIDE_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dismissed }),
        }),
      );
    },
  };
}
