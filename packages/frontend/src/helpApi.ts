import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core/personas/guide';
import type {
  HelpApi,
  HelpHealthCheck,
  HelpHealthItem,
  HelpHealthStatus,
  HelpHostReport,
  HelpHostReportState,
  Persona,
} from '@truefoundry/trueforge-ui';

const HEALTH_CHECK_URL = '/api/v1/help/health-check';
const HEALTH_STATUSES: readonly HelpHealthStatus[] = ['pass', 'warn', 'fail', 'not_set_up'];
const HOST_REPORT_STATES: readonly HelpHostReportState[] = ['ok', 'missing', 'invalid', 'stale'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && options.some(option => option === value);
}

function parseItem(value: unknown): HelpHealthItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isOneOf(value.status, HEALTH_STATUSES) ||
    typeof value.message !== 'string' ||
    !isNullableString(value.next_step)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    message: value.message,
    next_step: value.next_step,
  };
}

function parseHostReport(value: unknown): HelpHostReport | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isOneOf(value.state, HOST_REPORT_STATES) ||
    !isNullableString(value.checked_at) ||
    !isNullableString(value.message) ||
    !isNullableString(value.next_step)
  ) {
    return null;
  }
  return {
    state: value.state,
    checked_at: value.checked_at,
    message: value.message,
    next_step: value.next_step,
  };
}

/** Checks the response against the health check's fields. A response that does not match is an error, never a guess. */
export function parseHelpHealthCheck(value: unknown): HelpHealthCheck {
  if (!isRecord(value) || typeof value.checked_at !== 'string' || typeof value.model_ready !== 'boolean') {
    throw new Error('The help check response was invalid.');
  }
  if (!Array.isArray(value.items)) {
    throw new Error('The help check response was invalid.');
  }
  const items = value.items.map(parseItem);
  const hostReport = parseHostReport(value.host_report);
  if (items.some(item => item === null) || hostReport === null) {
    throw new Error('The help check response was invalid.');
  }
  return {
    checked_at: value.checked_at,
    model_ready: value.model_ready,
    items: items.filter((item): item is HelpHealthItem => item !== null),
    host_report: hostReport,
  };
}

async function readData(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' ? body.error.message : null;
    throw new Error(message ?? `Request failed (${String(response.status)}).`);
  }
  return isRecord(body) ? body.data : undefined;
}

/**
 * Help check and Iris install, over the same routes the rest of the app uses. Iris is installed by
 * the personas list route, so asking for the list is how she comes to exist before the chat opens.
 */
export function createHelpApi({
  fetcher,
  listPersonas,
}: {
  fetcher: typeof fetch;
  listPersonas: () => Promise<Persona[]>;
}): HelpApi {
  return {
    async getHealthCheck() {
      return parseHelpHealthCheck(await readData(await fetcher(HEALTH_CHECK_URL)));
    },
    async ensureGuide() {
      const personas = await listPersonas();
      return personas.some(persona => persona.display_name === AMAN_GUIDE_NAME);
    },
  };
}
