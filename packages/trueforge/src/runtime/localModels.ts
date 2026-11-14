import type { ModelAddressPlace, PlaceOfModelHost } from '@truefoundry/trueforge-core/core';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import configuration from '../config';
import type { ResolveAddresses } from './remoteAddress';

/** The name the app reaches the local model bridge at, on a network only the app and the bridge share. */
export const LOCAL_MODEL_BRIDGE_HOST = 'aman-local-model';

/** Machine-readable `error.code` when a model address is this computer and the local model bridge is the way to it. */
export const MODEL_ON_THIS_COMPUTER_CODE = 'model_on_this_computer';

/** What the installer told the app about the computer it runs on. Both are empty outside an installer instance. */
export interface LocalModels {
  /** This computer's own addresses and names, lowercase. */
  thisComputer: ReadonlySet<string>;
  /** Ports of this computer the local model bridge carries. */
  ports: readonly number[];
}

/** What the installer told this server, from its settings. */
export function localModelsFromConfig(): LocalModels {
  return {
    thisComputer: new Set(configuration.THIS_COMPUTER_ADDRESSES),
    ports: configuration.LOCAL_MODEL_PORTS,
  };
}

/** Name lookups wait this long at most, so a name that never answers cannot hold a Settings save. */
const LOOKUP_TIMEOUT_MS = 2_000;

async function defaultResolveHostAddresses(hostname: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string[]>(resolve => {
    timer = setTimeout(() => {
      resolve([]);
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      lookup(hostname, { all: true }).then(entries => entries.map(entry => entry.address)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isLoopbackAddress(address: string): boolean {
  return (isIP(address) === 4 && address.startsWith('127.')) || address === '::1';
}

/** True when this address is one of this computer's own, by its name or literal alone. */
function namesThisComputer({ hostname, local }: { hostname: string; local: LocalModels }): boolean {
  if (local.thisComputer.size === 0) {
    return false;
  }
  return local.thisComputer.has(hostname) || isLoopbackAddress(hostname);
}

/** Where a model host points, by name alone, for the words of a model connection that never started. */
export function placeOfModelHostFor(local: LocalModels): PlaceOfModelHost {
  return (rawHostname: string): ModelAddressPlace => {
    const hostname = normalHostname(rawHostname);
    if (hostname === LOCAL_MODEL_BRIDGE_HOST) {
      return 'local_link';
    }
    return namesThisComputer({ hostname, local }) ? 'this_computer' : 'elsewhere';
  };
}

/**
 * True when a model base URL is this computer: one of its own names or addresses, or a name that resolves to one. The
 * local model bridge itself is never this computer's address, since it is the way Aman reaches such a model. A name
 * that does not resolve is not taken for this computer.
 */
export async function isThisComputerModelUrl({
  baseUrl,
  local,
  resolveHostAddresses = defaultResolveHostAddresses,
}: {
  baseUrl: string;
  local: LocalModels;
  resolveHostAddresses?: ResolveAddresses;
}): Promise<boolean> {
  if (local.thisComputer.size === 0) {
    return false;
  }
  let hostname: string;
  try {
    hostname = normalHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
  if (hostname === LOCAL_MODEL_BRIDGE_HOST) {
    return false;
  }
  if (namesThisComputer({ hostname, local })) {
    return true;
  }
  if (isIP(hostname) !== 0) {
    return false;
  }
  let addresses: string[];
  try {
    addresses = await resolveHostAddresses(hostname);
  } catch {
    return false;
  }
  return addresses.some(address => namesThisComputer({ hostname: normalHostname(address), local }));
}

/** The address of a model on this computer through the local model bridge. */
export function localModelBridgeUrl(port: number | string): string {
  return `http://${LOCAL_MODEL_BRIDGE_HOST}:${String(port)}/v1`;
}

/**
 * What to do when the address check refuses an address of the local model bridge: the bridge's
 * port is not in the endpoint list, which aman local-model writes. Undefined for any other address.
 */
export function localModelBridgePortMessage(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (normalHostname(url.hostname) !== LOCAL_MODEL_BRIDGE_HOST) {
    return undefined;
  }
  if (url.port === '') {
    return (
      "This address has no port, and Aman's local link only carries the ports you add. " +
      "Add your model server's port to the address, for example http://aman-local-model:11434/v1."
    );
  }
  return (
    `Aman's local link does not carry port ${url.port} yet. ` +
    `On the computer Aman runs on, run aman local-model ${url.port}. Then try again.`
  );
}

/** Why Settings did not save a model address that is this computer, and the one thing to do instead. */
export function modelOnThisComputerMessage({ baseUrl, local }: { baseUrl: string; local: LocalModels }): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // The address is shown as given.
  }
  const why =
    `${host} is this computer. Aman reaches a model on this computer through its own local link, ` +
    'because an address like this one can stop working after a network change on this computer, such as a software update.';
  if (local.ports.length === 0) {
    return (
      `${why} On this computer, run aman local-model with the port your model server listens on, for example ` +
      'aman local-model 11434. Then save the model with the address that command shows.'
    );
  }
  const [only] = local.ports;
  if (local.ports.length === 1 && only !== undefined) {
    return (
      `${why} If your model server listens on port ${String(only)}, use the address ${localModelBridgeUrl(only)} instead. ` +
      'For another port, run aman local-model with that port on this computer first.'
    );
  }
  return (
    `${why} Use the address ${localModelBridgeUrl('PORT')} instead, where PORT is your model server's port. ` +
    `The local link carries ports ${local.ports.join(', ')}. For another port, run aman local-model with that port on this computer first.`
  );
}
