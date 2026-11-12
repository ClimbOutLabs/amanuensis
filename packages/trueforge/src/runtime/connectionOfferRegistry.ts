/**
 * The connectors a chat may offer to connect at the moment of need. This list is the one place
 * that says which connectors can be offered, what each one's card says, and how the host tells it
 * is connected. To add one, add an entry here with its words and its connected check; the tools,
 * the instruction, the remembered "Not now" and data export pick it up from this list.
 */
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';

/** What the host can see when it checks whether a connector is connected. */
export interface ConnectionOfferHost {
  /** True exactly while a mail account is saved: the Email connector is registered only then. */
  mailConnectorRegistered: () => Promise<boolean>;
  /** The saved Google login store; undefined on an instance with no Google wiring. */
  googleConnections: GoogleConnectionStore | undefined;
  owner: GoogleOwner;
}

export interface OfferableConnector {
  /** The id the offer tools take, and the end of the remembered decline's setting key. */
  id: string;
  /** The plain name the instruction uses, such as "email". */
  name: string;
  /** The kinds of task that need it, in plain words. */
  neededFor: string;
  /** The offer card's exact words. The latch recognises the card by them, so they can never drift apart. */
  question: string;
  connectOption: string;
  declineOption: string;
  /** The card in Settings, then Connectors, where the person connects it, and any other way there. */
  settingsCard: string;
  /** The whole reply after a no: one line, and it leaves Settings as the person's way back. */
  replyLine: string;
  /** Which route connects it now, or null when none does. */
  connectedVia: (host: ConnectionOfferHost) => Promise<string | null>;
}

/**
 * A saved mail account connects email, and so does a Google login that may read Gmail. A login
 * that needs reconnecting does not count, because mail through it is paused.
 */
const EMAIL: OfferableConnector = {
  id: 'email',
  name: 'email',
  neededFor: 'reading, searching, drafting or sending mail',
  question: 'Would you like to connect your email so I can do that?',
  connectOption: 'Connect my email',
  declineOption: 'Not now',
  settingsCard: 'the Email card (for Gmail, the Google card there connects mail too, and its own steps lead that way)',
  replyLine: 'No problem. You can connect it any time in Settings, then Connectors, from the Email card.',
  connectedVia: async host => {
    if (await host.mailConnectorRegistered()) {
      return 'email_account';
    }
    if (host.googleConnections === undefined) {
      return null;
    }
    const record = await host.googleConnections.get(host.owner);
    return record !== null &&
      record.status === 'connected' &&
      grantedFeatures(record.granted_scopes).includes('gmail_read')
      ? 'google'
      : null;
  },
};

export const OFFERABLE_CONNECTORS: readonly [OfferableConnector, ...OfferableConnector[]] = [EMAIL];

/** The remembered no for one connector, kept as an instance setting: one owner per instance, so one flag per connector is the whole record. */
export function connectionOfferDeclinedSettingKey(connectorId: string): string {
  return `connection_offer_declined_${connectorId}`;
}

/** Every remembered no the registry can hold, for data export and import. */
export const CONNECTION_OFFER_DECLINED_SETTING_KEYS: readonly string[] = OFFERABLE_CONNECTORS.map(connector =>
  connectionOfferDeclinedSettingKey(connector.id),
);
