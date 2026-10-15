/**
 * Calls the Harness Google routes (`/api/v1/user/settings/google/*`). Direct fetch rather than the generated
 * SDK until the SDK carries these routes; cookie auth rides along on the same-origin default, and a host
 * pointing the UI at another origin supplies its own `fetch`.
 */
import { z } from 'zod';
import {
  GoogleClientCheckSchema,
  GoogleConnectionStatusSchema,
  GoogleConsentStartSchema,
  GoogleDisconnectResultSchema,
  GoogleTestResultSchema,
  type GoogleClientDraft,
  type GoogleSetupPort,
} from '../../../server/googleSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

const ApiErrorResponseSchema = z.object({ error: z.object({ message: z.string() }) });

function clientBody(client: GoogleClientDraft) {
  return { client_id: client.clientId, client_secret: client.clientSecret, client_type: client.clientType };
}

export function createGoogleSetupApi(options: CreateTrueForgeClientOptions): GoogleSetupPort {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
  }): Promise<T> {
    const response = await fetchImpl(`${base}/api/v1/user/settings/google${input.path}`, {
      method: input.method,
      headers: {
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = ApiErrorResponseSchema.safeParse(body);
      throw new Error(
        failure.success ? failure.data.error.message : `Google request failed with HTTP ${String(response.status)}`,
      );
    }
    const parsed = z.object({ data: input.schema }).safeParse(body);
    if (!parsed.success) {
      throw new Error('Google returned an unreadable response');
    }
    return parsed.data.data;
  }

  return {
    getGoogleStatus: () => request({ method: 'GET', path: '/status', schema: GoogleConnectionStatusSchema }),
    checkGoogleClient: req =>
      request({
        method: 'POST',
        path: '/oauth/check-client',
        body: { client: clientBody(req.client), registered_redirect_uris: req.registeredRedirectUris },
        schema: GoogleClientCheckSchema,
      }),
    beginGoogleConsent: req =>
      request({
        method: 'POST',
        path: '/oauth/begin',
        body: { client: req.client === null ? null : clientBody(req.client), features: req.features },
        schema: GoogleConsentStartSchema,
      }),
    completeGoogleConsent: req =>
      request({
        method: 'POST',
        path: '/oauth/complete',
        body: { address: req.address },
        schema: GoogleConnectionStatusSchema,
      }),
    testGoogleConnection: () => request({ method: 'POST', path: '/test', schema: GoogleTestResultSchema }),
    disconnectGoogle: () => request({ method: 'POST', path: '/disconnect', schema: GoogleDisconnectResultSchema }),
  };
}
