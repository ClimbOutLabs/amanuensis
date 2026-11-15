import type { AccountConnectionState } from './accountSetup.js';

/**
 * The calendar account port the Harness adds on top of the runtime's connector port.
 * Hand-written wire types: the generated SDK has no calendar settings routes yet, so the
 * adapter calls the server endpoints directly and maps their snake_case fields here.
 */

/** One row of the provider picker. */
export interface CalendarProviderInfo {
  key: string;
  name: string;
  /** The built-in calendar address; null when it depends on the email domain, the email address or is typed. */
  serverUrl: string | null;
  /** A built-in calendar address made from the email address; null when the provider does not use one. */
  accountUrlTemplate: string | null;
  /** The provider's own help page for making an app password; null when none could be checked. */
  helpUrl: string | null;
  helpHint: string;
  /** Plain steps to show before the form; empty when the hint is enough. */
  setupSteps: string[];
}

/** One connected calendar account, as the Calendar card's list shows it. */
export interface CalendarAccountInfo {
  email: string;
  username: string;
  calendarUrl: string;
  providerKey: string;
  state: AccountConnectionState;
  isDefault: boolean;
}

/** The Calendar card's state. The app password is never part of it: the field is write-only. */
export interface CalendarAccountStatus {
  /** Whether this instance has the Calendar connector at all; when false, no card is shown. */
  available: boolean;
  state: AccountConnectionState;
  /** The email address of the default account; null when none is connected. */
  email: string | null;
  /** The login name of the default account, never the password; null when none is connected. */
  username: string | null;
  /** The calendar address of the default account; null when none is connected. */
  calendarUrl: string | null;
  providerKey: string;
  /** Every connected account, in the order they were added. */
  accounts: CalendarAccountInfo[];
  /** The default account's email address; null when none is connected. */
  defaultAddress: string | null;
  providers: CalendarProviderInfo[];
}

/** What the person entered in the form; the calendar address is used only for Other. */
export interface CalendarAccountSaveRequest {
  providerKey: string;
  email: string;
  password: string;
  username?: string;
  calendarUrl?: string;
}

/** Operations behind Settings, Connectors, Calendar. */
export interface CalendarSetupPort {
  getCalendarStatus(): Promise<CalendarAccountStatus>;
  /** Checks the sign-in first; a refused or unreachable check saves nothing and the error says why. */
  saveCalendarAccount(req: CalendarAccountSaveRequest): Promise<CalendarAccountStatus>;
  /** Deletes one saved account and its app password for good; with no address, every account goes. */
  removeCalendarAccount(address?: string): Promise<CalendarAccountStatus>;
  /** Makes the named account the default: the one a new event uses when none is named. */
  setDefaultCalendarAccount(address: string): Promise<CalendarAccountStatus>;
}

/** Whether a catalog implements the calendar port; another host's catalog may not. */
export function hasCalendarSetup(catalog: object): catalog is CalendarSetupPort {
  return typeof Reflect.get(catalog, 'getCalendarStatus') === 'function';
}
