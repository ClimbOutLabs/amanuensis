'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/atoms/primitives/Button.js';
import { useOptionalTerminalPairing, type PairedTerminal } from '@/components/TerminalPairingContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

const formatWhen = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function whenLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatWhen.format(date);
}

const LOAD_FAILED_LINE = 'The paired terminals could not be loaded. Try again in a moment.';
const REVOKE_FAILED_LINE = 'That terminal could not be revoked. Try again in a moment.';
const EMPTY_LINE = 'No terminal is paired yet. Pairing starts on the terminal, and you confirm it here in the web app.';

/**
 * Settings, Account: the terminals paired with this Aman. Each row names the terminal,
 * when it paired and when it was last used. Revoking one asks first, then takes it off
 * the list; the server stops it on its next request. Renders nothing when the host
 * offers no pairing surface.
 */
const PairedTerminalsSection = () => {
  const pairing = useOptionalTerminalPairing();
  const [terminals, setTerminals] = useState<PairedTerminal[] | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (pairing === null) {
      return;
    }
    try {
      setTerminals(await pairing.listPairedTerminals());
    } catch (cause) {
      setError(getErrorMessage(cause, LOAD_FAILED_LINE));
    }
  }, [pairing]);

  useEffect(() => {
    void load();
  }, [load]);

  if (pairing === null) {
    return null;
  }

  const handleRevoke = async (terminal: PairedTerminal) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairing.revokePairedTerminal({ terminal_key_id: terminal.id });
      setTerminals(previous => (previous ?? []).filter(row => row.id !== terminal.id));
      setConfirmingId(null);
    } catch (cause) {
      setError(getErrorMessage(cause, REVOKE_FAILED_LINE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card-bg p-4">
      <h3 className="text-sm font-semibold text-text-primary">Paired terminals</h3>
      <p className="mt-1 text-sm text-text-secondary">
        A terminal pairs with Aman instead of signing in, so it can reach your chats and nothing else. Revoking one
        stops it the next time it asks.
      </p>

      {error !== null ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
        >
          {error}
        </p>
      ) : null}

      {terminals === null && error !== null ? (
        <div className="mt-3">
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              setError(null);
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}

      {terminals === null && error === null ? <p className="mt-4 text-sm text-text-secondary">Checking…</p> : null}

      {terminals !== null && terminals.length === 0 ? (
        <p className="mt-4 text-sm text-text-secondary">{EMPTY_LINE}</p>
      ) : null}

      {terminals !== null && terminals.length > 0 ? (
        <div className="mt-4 space-y-3">
          {terminals.map(terminal => (
            <div key={terminal.id} className="rounded-md border border-border px-3 py-3">
              <p className="text-sm font-medium text-text-primary">{terminal.device_name}</p>
              <p className="mt-1 text-sm text-text-secondary">Paired {whenLabel(terminal.paired_at)}</p>
              <p className="text-sm text-text-secondary">Last used {whenLabel(terminal.last_used_at)}</p>
              {terminal.revoked_at !== null ? (
                <p className="mt-1 text-sm text-text-secondary">Revoked {whenLabel(terminal.revoked_at)}</p>
              ) : confirmingId === terminal.id ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="w-full text-sm text-text-secondary">
                    Revoke this terminal? It stops working the next time it asks. You can pair it again afterwards.
                  </p>
                  <Button type="button" disabled={busy} onClick={() => void handleRevoke(terminal)}>
                    Revoke
                  </Button>
                  <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingId(null)}>
                    Keep it
                  </Button>
                </div>
              ) : (
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmingId(terminal.id)}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default PairedTerminalsSection;
