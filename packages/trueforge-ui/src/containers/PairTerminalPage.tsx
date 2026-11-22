'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/atoms/primitives/Button.js';
import { useOptionalTerminalPairing, type TerminalPairingConfirmation } from '@/components/TerminalPairingContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

const CONFIRM_FAILED_LINE = 'That pairing did not work. On the terminal, start pairing again and use the new code.';
const NO_CODE_LINE = 'This link has no pairing code in it. On the terminal, start pairing again and open the new link.';
const NO_PAIRING_LINE = 'Pairing is not available here. Open this link in the web app where you use Aman.';
const NOT_YOUR_PAIRING_LINE = 'If you did not just start pairing on your own terminal, close this page.';

/**
 * The page a pairing link opens. The terminal that asked shows the same code, so the
 * person can check the two match before confirming. Nothing pairs until the person
 * presses the button: opening the link on its own pairs nothing. Before the confirm,
 * the page looks up the name of the terminal waiting on the code and shows it when
 * the server holds a live pairing for it. When it does not, the page shows the code
 * alone, as it did before the lookup existed.
 */
const PairTerminalPage = ({ code }: { code: string | null }) => {
  const pairing = useOptionalTerminalPairing();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<TerminalPairingConfirmation | null>(null);
  const [waitingName, setWaitingName] = useState<string | null>(null);

  useEffect(() => {
    if (pairing === null || code === null) {
      return;
    }
    let cancelled = false;
    pairing.lookupPairing({ code }).then(
      name => {
        if (!cancelled) {
          setWaitingName(name);
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [pairing, code]);

  const askingLine =
    waitingName !== null
      ? `${waitingName} is asking to pair with your Aman. Pairing lets that terminal reach your chats and answer approval cards in them, and nothing else.`
      : 'A terminal is asking to pair with your Aman. Pairing lets that terminal reach your chats and answer approval cards in them, and nothing else.';

  const handleConfirm = async () => {
    if (pairing === null || code === null || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPaired(await pairing.confirmPairing({ code }));
    } catch (cause) {
      setError(getErrorMessage(cause, CONFIRM_FAILED_LINE));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-primary-bg p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-border bg-card-bg p-8 text-center shadow-sm">
        {paired !== null ? (
          <>
            <h1 className="text-2xl font-semibold text-text-primary">Terminal paired</h1>
            <p className="text-sm leading-6 text-text-secondary">
              {paired.device_name} is paired and ready to use. You can close this page.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-text-primary">Pair a terminal</h1>
            {pairing === null ? (
              <p className="text-sm leading-6 text-text-secondary">{NO_PAIRING_LINE}</p>
            ) : code === null ? (
              <p className="text-sm leading-6 text-text-secondary">{NO_CODE_LINE}</p>
            ) : (
              <>
                <p className="text-sm leading-6 text-text-secondary">{askingLine}</p>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Pairing code</p>
                <p className="text-3xl font-semibold tracking-wide text-text-primary">{code}</p>
                <p className="text-sm leading-6 text-text-secondary">
                  Only confirm when this code matches the code on your terminal.
                </p>
                <p className="text-sm leading-6 text-text-secondary">{NOT_YOUR_PAIRING_LINE}</p>
                {error !== null ? (
                  <p
                    role="alert"
                    className="w-full rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
                  >
                    {error}
                  </p>
                ) : null}
                <Button type="button" disabled={busy} onClick={() => void handleConfirm()}>
                  {busy ? 'Pairing…' : 'Confirm pairing'}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
};

export default PairTerminalPage;
