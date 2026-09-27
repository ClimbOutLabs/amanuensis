/**
 * Maps trueforge-ui connector-settings calls onto Harness
 *
 * UI: `dcr` / `header` / `none`, connector `id`.
 * Harness: `dcr` / `header` / omitted auth, resource `name`.
 */
import { MEMORY_PROVIDER_MAX_TIMEOUT_MS } from '@truefoundry/trueforge-core/core/memory/memorySettingsLimits';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { z } from 'zod';
import {
  parseMemoryProviderCheck,
  type ConnectorChecks,
  type ConnectorConnectionFailureKind,
  type MemoryProviderCheck,
} from '../../../server/connectorChecks.js';

import type { MemoryProviderFields } from '../../../server/memoryProviderTypes.js';
import type {
  ConnectorAuth,
  ConnectorAuthPublic,
  ConnectorBase,
  ConnectorCatalogEntry,
  ConnectorCatalogServer,
  CreateConnectorRequest,
  ToolBase,
  UpdateConnectorRequest,
} from '../../../server/types.js';
import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

export type UiConnectorAuth = ConnectorAuth;
/**
 * Public auth, widened for `oauth_client`: the client secret is never sent in the clear.
 * `clientSecretDisplay` carries either a `${env:NAME}` / `${file:PATH}` reference (shown as-is)
 * or a masked value. It is display-only; the write path uses `clientSecret`.
 */
export type UiOAuthClientAuthPublic = {
  type: 'oauth_client';
  clientId?: string;
  scopes?: string[];
  clientSecretDisplay?: string;
};
export type UiConnectorAuthPublic =
  | Exclude<ConnectorAuthPublic, { type: 'oauth_client' }>
  | UiOAuthClientAuthPublic;
/**
 * `ConnectorBase` is the runtime's generic connector row type; it doesn't know about the
 * memory-provider flag. Widen locally rather than editing `@truefoundry/assistant-ui-runtime`.
 */
export type UiConnector = ConnectorBase & MemoryProviderFields;
export type UiConnectorCatalogEntry = ConnectorCatalogEntry;
/** `updateConnector` sends the full manifest; widen its request to carry the memory fields alongside it. */
export type UiUpdateConnectorRequest = UpdateConnectorRequest & MemoryProviderFields;
/**
 * Create carries the flag too, so pointing at a memory bank for the first time is one write that
 * the server validates once, rather than a create followed by a flag-setting update that could
 * fail and leave an unflagged row behind.
 */
export type UiCreateConnectorRequest = CreateConnectorRequest & MemoryProviderFields;

/** Five seconds past the longest deadline any memory check can be configured to, server-wide or per bank. */
const MEMORY_PROVIDER_WRITE_TIMEOUT_SECONDS = MEMORY_PROVIDER_MAX_TIMEOUT_MS / 1000 + 5;

/**
 * A memory-provider write performs a live recall before committing, waiting up to the bank's own
 * recall deadline (at most 120 s). Keep the browser request alive past that, and never retry a
 * write whose first attempt may have committed after the client lost its response.
 */
export function memoryProviderWriteRequestOptions(memoryProvider: boolean | undefined) {
  return memoryProvider === true
    ? { timeoutInSeconds: MEMORY_PROVIDER_WRITE_TIMEOUT_SECONDS, maxRetries: 0 }
    : undefined;
}

/**
 * The SDK's generated `McpServerManifest` type may not yet declare the memory fields (they land
 * on the server side first; the SDK's own convention camelCases them and maps them to the
 * `memory_provider` / `memory_settings` wire names via its serializer). Widen locally so this
 * package never edits the generated SDK package to add a field.
 */
type HarnessManifestWithMemory = TrueForgeApi.McpServerManifest & MemoryProviderFields;
type ConfiguredMcpServerWithMemory = TrueForgeApi.ConfiguredMcpServer & {
  manifest: HarnessManifestWithMemory;
};

const ApiErrorResponseSchema = z.object({ error: z.object({ message: z.string() }) });

/** The HTTP status the SDK puts on the errors it throws, when it threw one of those. */
function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/** 422 is the tools route's answer for a connector needing authentication; 502 is every other dial failure. */
function toConnectionFailureKind(status: number | undefined): ConnectorConnectionFailureKind {
  if (status === 422) {
    return 'auth_required';
  }
  if (status === 502) {
    return 'unreachable';
  }
  return 'error';
}

/**
 * Calls POST /api/v1/mcp-servers/{name}/memory-check with the same base URL, token, and fetch
 * the SDK client was built from. Direct rather than through the client because the generated
 * SDK does not carry this route yet; it moves onto the client at the next regeneration.
 * Cookie auth rides along: the default base URL is same-origin, and a host pointing the UI at
 * another origin supplies its own `fetch`.
 */
async function requestMemoryProviderCheck({
  name,
  options,
}: {
  name: string;
  options: CreateTrueForgeClientOptions;
}): Promise<MemoryProviderCheck> {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const response = await fetchImpl(`${base}/api/v1/mcp-servers/${encodeURIComponent(name)}/memory-check`, {
    method: 'POST',
    headers: options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = ApiErrorResponseSchema.safeParse(body);
    throw new Error(
      failure.success ? failure.data.error.message : `Memory check failed with HTTP ${String(response.status)}`,
    );
  }
  return parseMemoryProviderCheck(body);
}

/** Deleting a connector row is a local DB write; it never needs the SDK's full 60s default. */
const DELETE_CONNECTOR_TIMEOUT_SECONDS = 15;

const DEFAULT_API_KEY_HEADER = 'Authorization';
/** An existing auth scheme prefix, e.g. `Bearer `/`Basic ` - a scheme token followed by whitespace. */
const AUTH_SCHEME_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*\s/;

/** Matches a `${env:NAME}` / `${file:PATH}` secret reference exactly. References are pointers, not secrets. */
const SECRET_REFERENCE_PATTERN = /^\$\{(?:env|file):[^}]+\}$/;

/**
 * Safe secret display for the UI. A secret reference is shown as-is (it names where the secret
 * lives, it is not the secret). Any other value is masked to a fixed string so a full secret
 * can never reach the UI, even if a backend ever sent one by mistake.
 */
export function toUiSecretDisplay(value: string): string {
  if (SECRET_REFERENCE_PATTERN.test(value)) {
    return value;
  }
  return '••••••••';
}

export function toUiAuthPublic(
  auth: TrueForgeApi.McpServerManifestAuth | TrueForgeApi.McpServerAuthPublic | undefined,
): UiConnectorAuthPublic {
  if (auth === undefined) {
    return { type: 'none' };
  }
  if (auth.type === 'dcr') {
    return { type: 'dcr' };
  }
  if (auth.type === 'oauth_client') {
    const clientId = 'clientId' in auth && typeof auth.clientId === 'string' ? auth.clientId : undefined;
    const scopes = 'scopes' in auth && Array.isArray(auth.scopes) ? auth.scopes : undefined;
    const clientSecret =
      'clientSecret' in auth && typeof auth.clientSecret === 'string' ? auth.clientSecret : undefined;
    return {
      type: 'oauth_client',
      ...(clientId ? { clientId } : {}),
      ...(scopes ? { scopes } : {}),
      ...(clientSecret !== undefined && clientSecret !== ''
        ? { clientSecretDisplay: toUiSecretDisplay(clientSecret) }
        : {}),
    };
  }
  if (auth.type === 'header') {
    const headerName = 'headers' in auth ? Object.keys(auth.headers)[0] : undefined;
    return {
      type: 'header',
      ...(headerName === undefined ? {} : { headerName }),
    };
  }
  return { type: 'none' };
}

export function toHarnessAuth(auth: ConnectorAuth): TrueForgeApi.McpServerManifestAuth | undefined {
  if (auth.type === 'none') {
    return undefined;
  }
  if (auth.type === 'dcr') {
    return { type: 'dcr' };
  }
  if (auth.type === 'oauth_client') {
    if (!auth.clientId) {
      throw new Error('OAuth client authentication requires a client ID');
    }
    return {
      type: 'oauth_client',
      clientId: auth.clientId,
      clientSecret: auth.clientSecret || '',
      ...(auth.scopes ? { scopes: auth.scopes } : {}),
    };
  }
  const apiKey = auth.apiKey?.trim();
  if (apiKey === undefined || apiKey === '') {
    throw new Error('API key is required for header-authenticated MCP servers');
  }
  const trimmedHeader = auth.headerName?.trim();
  const headerName = trimmedHeader !== undefined && trimmedHeader !== '' ? trimmedHeader : DEFAULT_API_KEY_HEADER;
  const isAuthorizationHeader = headerName.toLowerCase() === DEFAULT_API_KEY_HEADER.toLowerCase();
  const value = isAuthorizationHeader && !AUTH_SCHEME_PREFIX_PATTERN.test(apiKey) ? `Bearer ${apiKey}` : apiKey;
  return { type: 'header', headers: { [headerName]: value } };
}

export function toUiCatalogEntry(server: TrueForgeApi.CatalogMcpServer): UiConnectorCatalogEntry {
  return {
    id: server.name,
    name: server.name,
    url: server.url,
    description: server.description,
    ...(server.logo === undefined ? {} : { logo: server.logo }),
    auth: toUiAuthPublic(server.auth),
  };
}

export type UiToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

function toUiToolAnnotations(value: unknown): UiToolAnnotations | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const readOnlyHint = Reflect.get(value, 'readOnlyHint');
  const destructiveHint = Reflect.get(value, 'destructiveHint');
  const annotations: UiToolAnnotations = {
    ...(typeof readOnlyHint === 'boolean' ? { readOnlyHint } : {}),
    ...(typeof destructiveHint === 'boolean' ? { destructiveHint } : {}),
  };
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function toUiTool(tool: Record<string, unknown>): ToolBase & { annotations?: UiToolAnnotations } {
  const name = typeof tool.name === 'string' && tool.name !== '' ? tool.name : 'tool';
  const description = typeof tool.description === 'string' ? tool.description : '';
  const annotations = toUiToolAnnotations(Reflect.get(tool, 'annotations'));
  return annotations === undefined ? { id: name, name, description } : { id: name, name, description, annotations };
}

export function toUiConnector(server: TrueForgeApi.ConfiguredMcpServer): UiConnector {
  const manifest = (server as ConfiguredMcpServerWithMemory).manifest;
  const auth = toUiAuthPublic(manifest.auth);
  return {
    id: server.name,
    name: server.name,
    description: manifest.description,
    url: manifest.url,
    auth,
    requiresAuth: server.authStatus.status === 'auth_required',
    authenticated: server.authStatus.status !== 'auth_required',
    ...(manifest.memoryProvider === undefined ? {} : { memoryProvider: manifest.memoryProvider }),
    ...(manifest.memorySettings === undefined ? {} : { memorySettings: manifest.memorySettings }),
  };
}

export function toUiConnectorFromReadEntry(server: TrueForgeApi.AvailableMcpServer): UiConnector {
  const auth = toUiAuthPublic(server.auth);
  return {
    id: server.name,
    name: server.name,
    description: server.url,
    url: server.url,
    auth,
    requiresAuth: server.authStatus.status === 'auth_required',
    authenticated: server.authStatus.status !== 'auth_required',
  };
}

export function toHarnessManifest(
  req: {
    name: string;
    url: string;
    auth: ConnectorAuth;
    description?: string;
  } & MemoryProviderFields,
): TrueForgeApi.McpServerManifest {
  const auth = toHarnessAuth(req.auth);
  const trimmed = req.description?.trim();
  const manifest: HarnessManifestWithMemory = {
    type: 'remote',
    name: req.name,
    url: req.url,
    description: trimmed !== undefined && trimmed !== '' ? trimmed : `${req.name} MCP server`,
    ...(auth === undefined ? {} : { auth }),
    ...(req.memoryProvider === undefined ? {} : { memoryProvider: req.memoryProvider }),
    ...(req.memorySettings === undefined ? {} : { memorySettings: req.memorySettings }),
  };
  return manifest;
}

/**
 * The connector port plus the two connection checks, which the runtime's generic port type does
 * not declare. Widened here rather than in `@truefoundry/assistant-ui-runtime`.
 */
export type HarnessConnectorCatalog = ConnectorCatalogServer<
  ToolBase,
  UiConnectorAuth,
  UiConnectorAuthPublic,
  UiConnector,
  UiConnectorCatalogEntry,
  UiCreateConnectorRequest,
  UiUpdateConnectorRequest
> &
  ConnectorChecks;

/** Settings connector port for `createTrueFoundryServer`. Delete omitted; disconnect unsupported. */
export function createConnectorCatalog(
  client: TrueForge,
  clientOptions: CreateTrueForgeClientOptions = {},
): HarnessConnectorCatalog {
  async function getConfigured(name: string): Promise<TrueForgeApi.ConfiguredMcpServer> {
    const listed = await client.settings.mcpServers.list();
    const existing = listed.data.find(server => server.name === name);
    if (existing === undefined) {
      throw new Error(`MCP server "${name}" not found`);
    }
    return existing;
  }

  /** One MCP `tools/list`, shared by tool discovery and the connection test so both dial alike. */
  async function listConnectorTools(name: string): Promise<ToolBase[]> {
    const body = await client.mcpServers.listTools(name);
    return body.data.map(toUiTool);
  }

  async function resolveWriteAuth(req: { id?: string; auth: ConnectorAuth }): Promise<ConnectorAuth> {
    if (req.auth.type !== 'header') {
      return req.auth;
    }
    const apiKey = req.auth.apiKey?.trim();
    if (apiKey !== undefined && apiKey !== '') {
      return req.auth;
    }
    if (req.id === undefined) {
      throw new Error('API key is required for header-authenticated MCP servers');
    }
    const existing = await getConfigured(req.id);
    if (existing.manifest.auth?.type !== 'header') {
      throw new Error(`MCP server "${req.id}" has no stored header credentials to reuse`);
    }
    const preferredHeader = req.auth.headerName?.trim();
    const storedHeaderName = Object.keys(existing.manifest.auth.headers)[0];
    const headerName =
      preferredHeader !== undefined && preferredHeader !== ''
        ? preferredHeader
        : (storedHeaderName ?? DEFAULT_API_KEY_HEADER);
    const stored = existing.manifest.auth.headers[headerName] ?? Object.values(existing.manifest.auth.headers)[0];
    if (stored === undefined) {
      throw new Error(`MCP server "${req.id}" has no stored header credentials to reuse`);
    }
    return { type: 'header', apiKey: stored, headerName };
  }

  return {
    getConnectorCatalog: async () => {
      const body = await client.catalogs.mcpServers.list();
      return body.data.map(toUiCatalogEntry);
    },
    getConnector: async req => {
      const body = await client.settings.mcpServers.get(req.id);
      return toUiConnector(body.data);
    },
    listConnectors: async req => {
      const body = await client.settings.mcpServers.list();
      const connectors = body.data.map(toUiConnector);
      const query = req?.query?.trim().toLowerCase();
      if (query === undefined || query === '') {
        return connectors;
      }
      return connectors.filter(
        connector =>
          connector.name.toLowerCase().includes(query) ||
          connector.description.toLowerCase().includes(query) ||
          connector.url.toLowerCase().includes(query),
      );
    },
    getToolsByConnectorId: async ({ id }) => listConnectorTools(id),
    createConnector: async req => {
      const auth = await resolveWriteAuth({ auth: req.auth });
      const body = await client.settings.mcpServers.create(
        {
          manifest: toHarnessManifest({
            name: req.name,
            url: req.url,
            auth,
            description: req.description,
            memoryProvider: req.memoryProvider,
            memorySettings: req.memorySettings,
          }),
        },
        memoryProviderWriteRequestOptions(req.memoryProvider),
      );
      return toUiConnector(body.data);
    },
    updateConnector: async req => {
      const auth = await resolveWriteAuth({ id: req.id, auth: req.auth });
      const body = await client.settings.mcpServers.createOrUpdate(
        {
          manifest: toHarnessManifest({
            name: req.id,
            url: req.url,
            auth,
            description: req.description,
            memoryProvider: req.memoryProvider,
            memorySettings: req.memorySettings,
          }),
        },
        memoryProviderWriteRequestOptions(req.memoryProvider),
      );
      return toUiConnector(body.data);
    },
    authenticateConnector: async req => {
      const result = await client.mcpServers.authorize(
        req.id,
        req.returnTo === undefined ? {} : { returnTo: req.returnTo },
      );
      return { status: result.status, authorization_endpoint: result.authorizationUrl };
    },
    disconnectConnector: async req => {
      const existing = await getConfigured(req.id);
      if (existing.manifest.auth?.type !== 'dcr' && existing.manifest.auth?.type !== 'oauth_client') {
        throw new Error(`Disconnect is only supported for OAuth MCP servers`);
      }
      const body = await client.mcpServers.deleteAuthorization(req.id);
      return toUiConnector(body.data);
    },
    deleteConnector: async req => {
      // The delete route itself is a local DB transaction (no live dial to the connector's own
      // endpoint), but a bounded timeout still caps how long a slow/unreachable Harness server can
      // hold the Settings UI in its "deleting…" state - the SDK's 60s default reads as a freeze.
      // maxRetries: 0 makes that bound real: the SDK's default retries a 408/429/5xx response up
      // to twice more, with delays of up to 60s between attempts, which would blow well past the
      // timeout below if left at its default even though each individual attempt still honors it.
      await client.settings.mcpServers.delete(req.id, {
        timeoutInSeconds: DELETE_CONNECTOR_TIMEOUT_SECONDS,
        maxRetries: 0,
      });
    },
    checkMemoryProvider: async req => requestMemoryProviderCheck({ name: req.id, options: clientOptions }),
    testConnector: async req => {
      try {
        const tools = await listConnectorTools(req.id);
        return { ok: true, toolNames: tools.map(tool => tool.name) };
      } catch (error) {
        // A failed dial is the answer here, not an exception: the caller renders what the
        // connector said. Only the transport's own message is ever shown.
        return {
          ok: false,
          kind: toConnectionFailureKind(readHttpStatus(error)),
          message: getErrorMessage(error, 'The connection test failed'),
        };
      }
    },
  };
}
