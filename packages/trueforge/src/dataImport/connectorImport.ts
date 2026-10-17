import type { AgentSpec } from '@truefoundry/trueforge-core/agent-session';

import type { McpServerRecord } from '../db/mcpServerStore';
import type { McpServerManifest } from '../schemas/mcpServer';
import { DataImportError } from './importError';
import type { ImportConnectorRecord } from './importSchemas';

/** `${env:NAME}` and `${file:PATH}` placeholders are expanded by the server on every connector call. */
const SECRET_REFERENCE = /\$\{\s*(?:env|file)\s*:/i;

const DCR_AUTH: { type: 'dcr' } = { type: 'dcr' };

export interface ImportedConnector {
  name: string;
  manifest: McpServerManifest;
}

/**
 * An archive can come from anywhere, so a connector keeps only its address and description, plus a
 * sign-in marker when it asks the owner to sign in. Credentials, trust marks and the memory and
 * search roles are never taken from it; the owner grants those in Settings.
 */
export function normalizeImportedConnectors(connectors: readonly ImportConnectorRecord[]): ImportedConnector[] {
  return connectors.map(connector => {
    if (SECRET_REFERENCE.test(JSON.stringify(connector.manifest))) {
      throw new DataImportError(
        `The connector "${connector.name}" in this export refers to a value on the server (an environment variable or a file), so nothing was imported. Remove that connector from the export and try again.`,
        400,
      );
    }
    const { manifest } = connector;
    const signIn = manifest.auth?.type === 'dcr' ? { auth: DCR_AUTH } : {};
    if (manifest.type === 'remote') {
      return {
        name: connector.name,
        manifest: {
          type: manifest.type,
          name: manifest.name,
          url: manifest.url,
          description: manifest.description,
          ...signIn,
        },
      };
    }
    return {
      name: connector.name,
      manifest: {
        type: manifest.type,
        name: manifest.name,
        url: manifest.url,
        description: manifest.description,
        ...signIn,
      },
    };
  });
}

/**
 * Leaves out the export's copy of the default web search connector this instance keeps. A connector
 * by that name with another address or a sign-in is the old owner's own, so the import refuses
 * instead of dropping it.
 */
export function withoutKeptConnector({
  connectors,
  kept,
}: {
  connectors: readonly ImportedConnector[];
  kept: McpServerRecord | undefined;
}): ImportedConnector[] {
  const copy = kept === undefined ? undefined : connectors.find(connector => connector.name === kept.name);
  if (kept === undefined || copy === undefined) {
    return [...connectors];
  }
  const sameConnector =
    copy.manifest.type === kept.manifest.type &&
    copy.manifest.url === kept.manifest.url &&
    copy.manifest.auth === undefined;
  if (!sameConnector) {
    throw new DataImportError(
      `The connector "${kept.name}" in this export differs from the web search connector this instance already has by that name, so nothing was imported. Remove that connector in Settings, then import again.`,
      409,
    );
  }
  return connectors.filter(connector => connector !== copy);
}

/** Imported connectors start unused: an agent keeps no attachment to them until the owner adds it. */
export function detachConnectors({ spec, names }: { spec: AgentSpec; names: ReadonlySet<string> }): AgentSpec {
  if (spec.mcp_servers === undefined) {
    return spec;
  }
  const { mcp_servers, ...rest } = spec;
  const kept = mcp_servers.filter(server => !names.has(server.name));
  return kept.length > 0 ? { ...rest, mcp_servers: kept } : rest;
}
