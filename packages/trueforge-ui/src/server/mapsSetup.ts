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

/**
 * The one message explaining why a maps server address cannot be saved, or
 * null when it can. Mirrors the server's own validation so the card can show
 * the problem under the field before anything is sent.
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
