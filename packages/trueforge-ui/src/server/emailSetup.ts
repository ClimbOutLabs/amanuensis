import type { AccountConnectionState } from './accountSetup.js';

/**
 * The email account port the Harness adds on top of the runtime's connector port.
 * Hand-written wire types: the generated SDK has no email settings routes yet, so the
 * adapter calls the server endpoints directly and maps their snake_case fields here.
 */

/** One row of the provider picker, with the servers a preset fills in. */
export interface EmailProviderInfo {
  key: string;
  name: string;
  imapHost: string;
  imapPort: number;
  imapMode: 'ssl' | 'starttls';
  smtpHost: string;
  smtpPort: number;
  smtpMode: 'ssl' | 'starttls';
  /** The provider's own help page for making an app password; null when none could be checked. */
  helpUrl: string | null;
  helpHint: string;
}

/** The Email card's state. The app password is never part of it: the field is write-only. */
export interface EmailAccountStatus {
  /** Whether this instance has the Email connector at all; when false, no card is shown. */
  available: boolean;
  state: AccountConnectionState;
  address: string | null;
  providerKey: string;
  providers: EmailProviderInfo[];
}

/** What the person entered in the form; the custom server fields are used only for Other. */
export interface EmailAccountSaveRequest {
  providerKey: string;
  address: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

/** Operations behind Settings, Connectors, Email. */
export interface EmailSetupPort {
  getEmailStatus(): Promise<EmailAccountStatus>;
  /** Checks the sign-in first; a refused or unreachable check saves nothing and the error says why. */
  saveEmailAccount(req: EmailAccountSaveRequest): Promise<EmailAccountStatus>;
  /** Deletes the saved account and its app password for good. */
  removeEmailAccount(): Promise<EmailAccountStatus>;
}

/** Whether a catalog implements the email port; another host's catalog may not. */
export function hasEmailSetup(catalog: object): catalog is EmailSetupPort {
  return typeof Reflect.get(catalog, 'getEmailStatus') === 'function';
}
