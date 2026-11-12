/**
 * The connection state both account cards (Email, Calendar) show. It is written once so a new state reaches both
 * cards, their wire parsing and their panels together.
 */
export const ACCOUNT_CONNECTION_STATES = ['connected', 'not_connected', 'sign_in_stopped', 'not_working'] as const;

/** Connected, none saved, saved but the login was refused, or saved but the server cannot be reached right now. */
export type AccountConnectionState = (typeof ACCOUNT_CONNECTION_STATES)[number];
