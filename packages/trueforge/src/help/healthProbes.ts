import { extractErrorLogFields, isAuthRequired, RemoteMCP, VercelAILLM } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { getMcpConnection, getModelDetails } from '../runtime/sessionResources';
import { readDefaultChatModel } from '../runtime/tokenFactoryProvider';
import type { ConnectorProbe, ModelProbe } from './healthCheck';

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
  const modelName = await readDefaultChatModel({ globalSettingsStore, logger });
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
