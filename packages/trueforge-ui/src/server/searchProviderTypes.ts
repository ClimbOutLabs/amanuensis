/**
 * Host-only search-provider field carried alongside the generic connector port.
 *
 * The upstream assistant UI runtime knows only generic MCP connectors. The server stores the
 * user's web search provider as one of those rows with this extension flag, so the catalog adapter
 * and the connector settings derive their types from this single owner.
 */
import type { ConnectorBase } from './types.js';

export type SearchProviderFields = {
  searchProvider?: boolean;
};

/**
 * The flag as the wire carries it. Kept snake_case: the generated SDK does not declare this field
 * yet (it landed on the server first), and its client passes unrecognized object keys through
 * unchanged rather than case-converting them, so the name written here is the literal wire name.
 */
export type SearchProviderWireFields = {
  search_provider?: boolean;
};

/** Reads the flag from a manifest or catalog entry in either spelling, so a regenerated SDK changes nothing. */
export function readSearchProviderFlag(value: object): boolean | undefined {
  const flag: unknown = Reflect.get(value, 'search_provider') ?? Reflect.get(value, 'searchProvider');
  return typeof flag === 'boolean' ? flag : undefined;
}

/** Reads the flag off the row rather than asserting it is there: `ConnectorBase` does not declare it. */
export function isSearchProvider(connector: ConnectorBase): boolean {
  return Reflect.get(connector, 'searchProvider') === true;
}
