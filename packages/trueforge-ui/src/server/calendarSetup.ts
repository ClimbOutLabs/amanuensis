/**
 * The calendar account port the Harness adds on top of the runtime's connector port.
 * Hand-written wire types: the generated SDK has no calendar settings routes yet, so the
 * adapter calls the server endpoints directly and maps their snake_case fields here.
 */

/** One row of the provider picker. */
export interface CalendarProviderInfo {
  key: string;
  name: string;
  /** The built-in calendar address; null when it depends on the email domain or is typed. */
  serverUrl: string | null;
  /** The provider's own help page for making an app password; null when none could be checked. */
  helpUrl: string | null;
  helpHint: string;
}

/** The Calendar card's state. The app password is never part of it: the field is write-only. */
export interface CalendarAccountStatus {
  /** Whether this instance has the Calendar connector at all; when false, no card is shown. */
  available: boolean;
  state: 'connected' | 'not_connected' | 'sign_in_stopped';
  /** The email address of the connected account; null when none is connected. */
  email: string | null;
  providerKey: string;
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
  /** Deletes the saved account and its app password for good. */
  removeCalendarAccount(): Promise<CalendarAccountStatus>;
}

/** Whether a catalog implements the calendar port; another host's catalog may not. */
export function hasCalendarSetup(catalog: object): catalog is CalendarSetupPort {
  return typeof Reflect.get(catalog, 'getCalendarStatus') === 'function';
}
