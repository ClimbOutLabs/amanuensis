'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * One paired terminal, as the Settings list shows it: the wire shape of the paired
 * terminals route. Names and times only. The key and its scrambled copy never cross.
 */
export type PairedTerminal = {
  id: string;
  device_name: string;
  /** When the terminal was paired, as an ISO 8601 timestamp. */
  paired_at: string;
  /** When the terminal last signed a request, as an ISO 8601 timestamp. */
  last_used_at: string;
  /** When the terminal was revoked, as an ISO 8601 timestamp, or null while it can still sign in. */
  revoked_at: string | null;
};

/** What a confirmed pairing tells the page: the terminal that was paired, and when. */
export type TerminalPairingConfirmation = {
  device_name: string;
  paired_at: string;
};

/**
 * The terminal pairing surface: confirming a pairing code, looking up the terminal
 * waiting on one, and looking after the terminals already paired. Hosts provide it;
 * absent it, the pairing page and the Paired terminals list in Settings never render.
 */
export type TerminalPairingApi = {
  /**
   * The name of the terminal waiting on a pairing code, or null when the server
   * holds no live pairing for that code. Wrong, expired and already used codes all
   * answer the same way, so the page cannot tell them apart. This never throws:
   * when no name comes back, the page shows the code alone, as it did before the
   * lookup existed.
   */
  lookupPairing: (input: { code: string }) => Promise<string | null>;
  /**
   * Confirms a pairing code for the signed-in person and pairs the terminal that
   * asked. A failure throws an Error whose message is one plain line the page can
   * show as-is. A code that is wrong, expired or already used gets the server's one
   * refusal line, which never says which of the three it was.
   */
  confirmPairing: (input: { code: string }) => Promise<TerminalPairingConfirmation>;
  /** Every terminal the person paired, newest first, revoked ones included. */
  listPairedTerminals: () => Promise<PairedTerminal[]>;
  /**
   * Revokes one paired terminal, which stops working on its next request. A failure
   * throws an Error whose message is one plain line the list can show as-is.
   */
  revokePairedTerminal: (input: { terminal_key_id: string }) => Promise<void>;
};

const TerminalPairingContext = createContext<TerminalPairingApi | null>(null);

export const TerminalPairingProvider: FC<{ api: TerminalPairingApi; children: ReactNode }> = ({ api, children }) => (
  <TerminalPairingContext.Provider value={api}>{children}</TerminalPairingContext.Provider>
);

/** Null when no host has wired a `TerminalPairingProvider`. */
export function useOptionalTerminalPairing(): TerminalPairingApi | null {
  return useContext(TerminalPairingContext);
}
