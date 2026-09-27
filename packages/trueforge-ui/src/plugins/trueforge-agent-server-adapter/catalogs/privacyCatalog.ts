import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** Whether the server currently refuses all non-local network calls. */
export interface OfflineModeState {
  enabled: boolean;
}

/** One external connection the system can make, in plain language. */
export interface DataFlowConnection {
  id: string;
  category: string;
  destination: string;
  dataSent: string;
  purpose: string;
  howToDisable: string;
}

export interface DataFlowManifest {
  version: string;
  connections: DataFlowConnection[];
}

export interface PrivacyCatalog {
  getOfflineMode(): Promise<OfflineModeState>;
  setOfflineMode(enabled: boolean): Promise<OfflineModeState>;
  getDataFlowManifest(): Promise<DataFlowManifest>;
  /**
   * Downloads the full export zip and saves it under a dated filename.
   * Fetches with the catalog auth (token or cookies) instead of a plain
   * link so Bearer <redacted> work too.
   */
  downloadExport(): Promise<void>;
}

const OfflineModeResponseSchema = z.object({
  data: z.object({ enabled: z.boolean() }),
});

const DataFlowManifestResponseSchema = z.object({
  data: z.object({
    version: z.string(),
    connections: z.array(
      z.object({
        id: z.string(),
        category: z.string(),
        destination: z.string(),
        data_sent: z.string(),
        purpose: z.string(),
        how_to_disable: z.string(),
      }),
    ),
  }),
});

function parseOfflineMode(body: unknown): OfflineModeState {
  const parsed = OfflineModeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected offline-mode payload');
  }
  return { enabled: parsed.data.data.enabled };
}

function parseManifest(body: unknown): DataFlowManifest {
  const parsed = DataFlowManifestResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected data-flow payload');
  }
  return {
    version: parsed.data.data.version,
    connections: parsed.data.data.connections.map(connection => ({
      id: connection.id,
      category: connection.category,
      destination: connection.destination,
      dataSent: connection.data_sent,
      purpose: connection.purpose,
      howToDisable: connection.how_to_disable,
    })),
  };
}

/**
 * Calls GET/PUT /api/v1/privacy/* with the same base URL, token, and fetch the
 * SDK client was built from. Direct rather than through the client because the
 * generated SDK does not carry these routes yet; they move onto the client at
 * the next regeneration. Cookie auth rides along: the default base URL is
 * same-origin, and a host pointing the UI at another origin supplies its own `fetch`.
 */
export function createPrivacyCatalog(options: CreateTrueForgeClientOptions = {}): PrivacyCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: 'GET' | 'PUT', path: string, body?: { enabled: boolean }): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(getErrorMessage(error, `Privacy request to ${path} failed`), { cause: error });
    }
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        failure.success ? failure.data.error.message : `Privacy request failed with HTTP ${String(response.status)}`,
      );
    }
    return responseBody;
  }

  return {
    async getOfflineMode() {
      return parseOfflineMode(await request('GET', '/api/v1/privacy/offline-mode'));
    },
    async setOfflineMode(enabled: boolean) {
      return parseOfflineMode(await request('PUT', '/api/v1/privacy/offline-mode', { enabled }));
    },
    async getDataFlowManifest() {
      return parseManifest(await request('GET', '/api/v1/privacy/data-flow'));
    },
    async downloadExport() {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/api/v1/privacy/export`, {
          headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
        });
      } catch (error) {
        throw new Error(getErrorMessage(error, 'The export download failed'), { cause: error });
      }
      if (!response.ok) {
        const responseBody: unknown = await response.json().catch(() => undefined);
        const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
        throw new Error(
          failure.success ? failure.data.error.message : `Export failed with HTTP ${String(response.status)}`,
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `amanuensis-export-${dateStamp}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
  };
}
