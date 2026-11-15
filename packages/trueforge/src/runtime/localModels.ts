import type { ModelAddressPlace } from '@truefoundry/trueforge-core/core';

/** The name the app reaches the local model bridge at, on a network only the app and the bridge share. */
export const LOCAL_MODEL_BRIDGE_HOST = 'aman-local-model';

function normalHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** Where a model host points, by name alone, for the words of a model connection that never started. */
export function placeOfModelHost(rawHostname: string): ModelAddressPlace {
  return normalHostname(rawHostname) === LOCAL_MODEL_BRIDGE_HOST ? 'local_link' : 'elsewhere';
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
