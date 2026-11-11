/**
 * The maps server port the Harness adds on top of the runtime's connector
 * port. The adapter drives it through the generated SDK client for the maps
 * settings routes. The server is the one judge of an address, so this layer
 * carries no address rule of its own: the card sends what the person typed
 * and shows the server's answer, per field.
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

/** The problem the server named for a field it refused, keyed by the field it belongs to. */
export type MapsSettingsFieldProblems = Partial<Record<MapsServerFieldId, string>>;

/**
 * A save the server refused. The refusal names the problem under each field
 * that has one, so the card shows the message with the field it belongs to
 * instead of one error for the whole card.
 */
export class MapsSettingsSaveRefused extends Error {
  readonly problems: MapsSettingsFieldProblems;

  constructor(problems: MapsSettingsFieldProblems) {
    super('The server refused to save the maps addresses.');
    this.name = 'MapsSettingsSaveRefused';
    this.problems = problems;
  }
}

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
