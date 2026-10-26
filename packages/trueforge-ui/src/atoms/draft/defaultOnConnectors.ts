import { DEFAULT_ON_SOURCE_CONNECTOR_NAMES } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';

import { isSearchProvider } from '../../server/searchProviderTypes.js';
import type { ConnectorState } from '../../server/types.js';

/** Whether every chat has this connector on until the person turns it off for that chat. */
export function isDefaultOnConnector(connector: ConnectorState): boolean {
  return DEFAULT_ON_SOURCE_CONNECTOR_NAMES.includes(connector.name) || isSearchProvider(connector);
}
