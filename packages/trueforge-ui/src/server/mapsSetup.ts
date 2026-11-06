/**
 * The maps server port the Harness adds on top of the runtime's connector port.
 * Hand-written wire types: the generated SDK has no maps settings routes yet, so
 * the adapter calls the server endpoints directly and maps their snake_case
 * fields here.
 */

/** The six maps servers, in the order the Settings card shows them. */
export const MAPS_SERVER_FIELD_IDS = ['router', 'walking', 'cycling', 'geocoder', 'transit', 'tile'] as const;

export type MapsServerFieldId = (typeof MAPS_SERVER_FIELD_IDS)[number];

/** The field labels the card shows, from the brief for this card. */
export const MAPS_SERVER_FIELD_LABELS: Record<MapsServerFieldId, string> = {
  router: 'Driving routes',
  walking: 'Walking routes',
  cycling: 'Cycling routes',
  geocoder: 'Address search',
  transit: 'Public transport',
  tile: 'Map pictures',
};

/** The name a person would use for each server, for messages. */
const MAPS_SERVER_MESSAGE_LABELS: Record<MapsServerFieldId, string> = {
  router: 'driving route',
  walking: 'walking route',
  cycling: 'cycling route',
  geocoder: 'address search',
  transit: 'public transport',
  tile: 'map pictures',
};

/** The octets of a dotted IPv4 address, or null when the host is not one. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return octets;
}

/** A host without its IPv6 brackets, lowercased. */
function bareHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Whether the host is a link-local address or the cloud metadata address, which are never a maps server. */
function isLinkLocalOrMetadataHost(hostname: string): boolean {
  const bare = bareHost(hostname);
  if (bare === 'metadata.google.internal') {
    return true;
  }
  const octets = ipv4Octets(bare);
  if (octets !== null) {
    return octets[0] === 169 && octets[1] === 254;
  }
  if (bare.includes(':')) {
    const firstGroup = Number.parseInt(bare.split(':')[0] ?? '', 16);
    return !Number.isNaN(firstGroup) && firstGroup >= 0xfe80 && firstGroup <= 0xfebf;
  }
  return false;
}

/** Whether plain http may go to this host: this computer or a private network address. */
function isLoopbackOrPrivateHost(hostname: string): boolean {
  const bare = bareHost(hostname);
  if (bare === 'localhost' || bare === '::1') {
    return true;
  }
  const octets = ipv4Octets(bare);
  if (octets !== null) {
    const [a, b] = octets;
    if (a === 127 || a === 10 || (a === 192 && b === 168)) {
      return true;
    }
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) {
      return true;
    }
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
  }
  if (bare.includes(':')) {
    return false;
  }
  return !bare.includes('.') || bare.endsWith('.local') || bare.endsWith('.ts.net');
}

/**
 * The one message explaining why a maps server address cannot be saved, or
 * null when it can. Mirrors the server's one maps address rule (mapsUrlProblem
 * in the server's config.ts) so the card can show the problem under the field
 * before anything is sent: https anywhere; plain http only for this computer
 * or a private network; no query or hash; no user name or password in the
 * address; link-local and cloud metadata addresses refused.
 */
export function mapsServerUrlProblem({ field, value }: { field: MapsServerFieldId; value: string }): string | null {
  const label = MAPS_SERVER_MESSAGE_LABELS[field];
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return `The ${label} address does not look like a complete web address. Check it and try again.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `The ${label} address must start with http:// or https://.`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return `The ${label} address has a user name or password in it. Maps addresses cannot have one. Take it out and try again.`;
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return `The ${label} address has a ? or # part in it. Maps addresses cannot have one. Take that part off and try again.`;
  }
  if (isLinkLocalOrMetadataHost(parsed.hostname)) {
    return `The ${label} address is a link-local or cloud metadata address. Those addresses belong to the network itself, so they cannot be a maps server. Check the address and try again.`;
  }
  if (parsed.protocol === 'http:' && !isLoopbackOrPrivateHost(parsed.hostname)) {
    return `The ${label} address starts with http://, which is not encrypted. Plain http is only allowed for a server on this computer or your home network. Use the https:// address, or a home network address.`;
  }
  if (field === 'tile') {
    for (const placeholder of ['{z}', '{x}', '{y}']) {
      if (!value.includes(placeholder)) {
        return 'The map pictures address needs {z}, {x} and {y} in it, like https://tile.example.org/{z}/{x}/{y}.png.';
      }
    }
  }
  return null;
}

/** One maps server field as the card shows it. */
export interface MapsServerFieldState {
  /** The environment address when the environment sets one, else the saved address, else null. */
  value: string | null;
  /** The built-in default address, shown as the field placeholder. */
  defaultUrl: string;
  /** Whether the server environment sets this address; the field is read-only then. */
  setByEnvironment: boolean;
}

/** Every maps server field as the card shows it. */
export type MapsSettingsState = Record<MapsServerFieldId, MapsServerFieldState>;

/** Addresses to save: a string saves, null clears back to the default, an absent field is left as it is. */
export type MapsSettingsUpdate = Partial<Record<MapsServerFieldId, string | null>>;

/** One service's answer to the Test connections button. */
export interface MapsServerTestResult {
  ok: boolean;
  /** Why the test failed, in plain words; null when the server answered. */
  message: string | null;
}

/** Every service's answer to a connection test, reported separately. */
export type MapsSettingsTestResults = Record<MapsServerFieldId, MapsServerTestResult>;

/** Operations behind Settings, Connectors, Maps. Admin only on the server. */
export interface MapsSetupPort {
  getMapsSettings(): Promise<MapsSettingsState>;
  updateMapsSettings(update: MapsSettingsUpdate): Promise<MapsSettingsState>;
  testMapsSettings(): Promise<MapsSettingsTestResults>;
}

/** Whether a catalog implements the maps port; another host's catalog may not. */
export function hasMapsSetup(catalog: object): catalog is MapsSetupPort {
  return typeof Reflect.get(catalog, 'getMapsSettings') === 'function';
}
