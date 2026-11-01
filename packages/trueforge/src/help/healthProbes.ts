import { extractErrorLogFields, isAuthRequired, RemoteMCP, VercelAILLM } from '@truefoundry/trueforge-core/core';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleReconnectRequiredError } from '@truefoundry/trueforge-core/core/google/errors';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { resolveDefaultChatModel } from '../runtime/defaultChatModel';
import { getMcpConnection, getModelDetails } from '../runtime/sessionResources';
import type { ConnectorProbe, GoogleLoginProbe, ModelProbe } from './healthCheck';

/** The test call is one word and must not hold a person's page open. */
export const MODEL_PROBE_TIMEOUT_MS = 8_000;
/** Each connector is asked in parallel, so one slow connector cannot hold up the others. */
export const CONNECTOR_PROBE_TIMEOUT_MS = 5_000;

/**
 * One tiny test call to the default chat model. Uses the same provider lookup as a turn, but no
 * tools, no memory and no metering, so the check costs a fraction of a token.
 */
export async function probeModel({
  tenantId,
  modelProviderStore,
  globalSettingsStore,
  logger,
}: {
  tenantId: string;
  modelProviderStore: IModelProviderStore;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<ModelProbe> {
  const modelName = await resolveDefaultChatModel({ tenantId, modelProviderStore, globalSettingsStore, logger });
  if (modelName === undefined) {
    return { kind: 'no_default' };
  }
  const details = await getModelDetails({ tenant_id: tenantId, name: modelName, store: modelProviderStore }).catch(
    (error: unknown) => {
      logger.warn('Help check: the default model is not set up', extractErrorLogFields(error));
      return undefined;
    },
  );
  if (details === undefined) {
    return { kind: 'misconfigured' };
  }
  const llm = new VercelAILLM({
    providerConfig: details.providerConfig,
    logger,
    signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
    streamTimeout: details.streamTimeout,
  });
  try {
    await llm.createNonStream({
      messages: [{ role: 'user', content: 'Reply with the word ok.' }],
      max_completion_tokens: 8,
      temperature: 0,
      top_p: 1,
    });
    return { kind: 'answered' };
  } catch (error) {
    logger.warn('Help check: the default model did not answer', extractErrorLogFields(error));
    return { kind: 'no_answer' };
  }
}

/**
 * Checks the built-in Google login by refreshing its access token, the same call a Gmail or Calendar tool makes.
 * Only the outcome leaves this function, never a token.
 */
export async function probeGoogleLogin({
  owner,
  connections,
  fetchImpl,
  logger,
}: {
  owner: GoogleOwner;
  connections: GoogleConnectionStore;
  /** Replaceable so tests never reach Google. */
  fetchImpl: typeof fetch | undefined;
  logger: Logger;
}): Promise<GoogleLoginProbe> {
  const record = await connections.get(owner);
  if (record === null) {
    return 'not_set_up';
  }
  const features = grantedFeatures(record.granted_scopes);
  if (!features.includes('gmail_read') && !features.includes('calendar_read')) {
    return 'not_set_up';
  }
  if (record.status === 'needs_reconnect') {
    return 'needs_reconnect';
  }
  try {
    await new GoogleAccessTokens({ connections, owner, now: undefined, fetchImpl }).get();
    return 'answered';
  } catch (error) {
    if (error instanceof GoogleReconnectRequiredError) {
      return 'needs_reconnect';
    }
    logger.warn('Help check: the Google login did not answer', extractErrorLogFields(error));
    return 'no_answer';
  }
}

/**
 * Asks each enabled MCP connector for its tool list, the same call the settings page makes. Returns
 * names and ok/not ok only; a token or URL never leaves this function.
 */
export async function probeConnectors({
  tenantId,
  userRef,
  mcpServerStore,
  tokenStore,
  clientName,
  requestTimeoutMs,
  connectTimeoutMs,
  logger,
}: {
  tenantId: string;
  userRef: string;
  mcpServerStore: IMcpServerStore;
  tokenStore: IOAuthTokenStore;
  clientName: string | undefined;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  logger: Logger;
}): Promise<ConnectorProbe[]> {
  const servers = await mcpServerStore.listServers({ tenant_id: tenantId, names: undefined });
  return await Promise.all(
    servers.map(async (server): Promise<ConnectorProbe> => {
      const name = server.name;
      try {
        const connection = await getMcpConnection({
          tenant_id: tenantId,
          name,
          store: mcpServerStore,
          tokenStore,
          clientName,
          userRef,
        });
        if (connection === undefined) {
          return { name, ok: false };
        }
        const remote = new RemoteMCP({
          id: name,
          name,
          url: connection.url,
          headers: connection.headers,
          requestTimeoutMs,
          connectTimeoutMs,
          refuseRedirects: connection.first_party,
          logger,
          signal: AbortSignal.timeout(CONNECTOR_PROBE_TIMEOUT_MS),
        });
        const response = await remote.listTools();
        return { name, ok: !isAuthRequired(response) };
      } catch (error) {
        logger.warn(`Help check: connector "${name}" did not answer`, extractErrorLogFields(error));
        return { name, ok: false };
      }
    }),
  );
}
