'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import type { TelegramAccountStatus, TelegramSetupPort } from '@/server/telegramSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

type TelegramSetupPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  port: TelegramSetupPort;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
};

const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';

const BOTFATHER_HELP = 'Open Telegram, message @BotFather, send /newbot, paste the token here.';

/**
 * The Telegram card's setup panel: paste a bot token, then pair. The token is typed here and nowhere
 * else: it goes straight to the server endpoint, is cleared from this form on every answer, and is
 * never shown back. Pairing takes two steps on purpose: the bot sends the code only inside Telegram,
 * and this panel shows the name of whoever is waiting to pair, so the owner pairs only when that
 * name is theirs, by typing the code from Telegram. A stranger who messaged the bot first shows
 * their own name here and can be cancelled instead of paired.
 */
export default function TelegramSetupPanel({ open, onOpenChange, port, onChanged }: TelegramSetupPanelProps) {
  const [status, setStatus] = useState<TelegramAccountStatus | null>(null);
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((next: TelegramAccountStatus) => {
    setStatus(next);
    setToken('');
    setCode('');
    setConfirmingRemove(false);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setToken('');
    setCode('');
    let cancelled = false;
    void port
      .getTelegramStatus()
      .then(next => {
        if (!cancelled) {
          applyStatus(next);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(caught, "Couldn't check Telegram just now. Try again."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, port, applyStatus]);

  const run = async (action: () => Promise<TelegramAccountStatus>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await action());
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, fallback));
      // A call that was cut off may still have gone through, so the list asks again.
      onChanged();
    } finally {
      setBusy(false);
      setToken('');
    }
  };

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault();
    await run(() => port.connectTelegram({ token: token.trim() }), "Couldn't connect that bot. Try again.");
  };

  const handleConfirm = async (event: FormEvent) => {
    event.preventDefault();
    await run(() => port.confirmTelegramPairing({ code: code.trim() }), "Couldn't confirm that code. Try again.");
  };

  const handleCancelPairing = async () => {
    await run(() => port.cancelTelegramPairing(), "Couldn't cancel that pairing. Try again.");
  };

  const handleRemove = async () => {
    await run(() => port.removeTelegram(), "Couldn't disconnect the bot. Try again.");
  };

  const removeControls = confirmingRemove ? (
    <div className="flex flex-wrap items-center gap-2">
      <p className="w-full text-text-secondary">Disconnect this bot? The saved token is deleted for good.</p>
      <Button type="button" disabled={busy} onClick={() => void handleRemove()}>
        Disconnect
      </Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>
        Keep it
      </Button>
    </div>
  ) : (
    <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(true)}>
      Disconnect
    </Button>
  );

  const botLine =
    status?.botName !== null && status?.botName !== undefined
      ? `${status.botName}${status.botUsername !== null ? ` (@${status.botUsername})` : ''}`
      : null;

  return (
    <CenteredModal
      open={open}
      onOpenChange={onOpenChange}
      title="Telegram"
      description="Connect a Telegram bot, so you can message your assistant from Telegram and get replies, reminders and ok requests there."
      className="md:max-w-2xl"
    >
      <div className="space-y-5 px-5 py-5 text-sm text-text-primary">
        {error ? (
          <p role="alert" className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg">
            {error}
          </p>
        ) : null}

        {status === null && error === null ? <p className="text-text-secondary">Checking…</p> : null}

        {status !== null && status.state === 'not_connected' ? (
          <form onSubmit={event => void handleConnect(event)} className="space-y-4">
            <p className="text-text-secondary">{BOTFATHER_HELP}</p>
            <div>
              <label htmlFor="telegram-token" className={LABEL_CLASS}>
                Bot token
              </label>
              <input
                id="telegram-token"
                type="password"
                value={token}
                onChange={event => setToken(event.target.value)}
                placeholder="Paste the token from BotFather"
                autoFocus
                required
                className={auiInputClass('h-11')}
              />
            </div>
            <p className="text-text-secondary">
              The token is checked with Telegram before anything is saved. It is saved only on this computer and never
              shown again.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="submit" disabled={busy || token.trim() === ''}>
                {busy ? 'Checking…' : 'Connect'}
              </Button>
            </div>
          </form>
        ) : null}

        {status !== null && status.state === 'awaiting_pairing' ? (
          <div className="space-y-4">
            <p>
              Your bot <span className="font-medium">{botLine}</span> is connected. One step is left: pair it with you,
              so it answers only you.
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-text-secondary">
              <li>Open Telegram and message your bot.</li>
              <li>Send /start. The bot answers with a six-digit code.</li>
              <li>Check the name below is yours, type the code from Telegram here and press Pair.</li>
            </ol>
            <p className="text-text-secondary">
              The code is shown only in Telegram, never here. This panel shows who is waiting to pair instead, so you
              can check it is you before pairing.
            </p>
            {status.pairingName !== null ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>
                  Waiting to pair: <span className="font-medium">{status.pairingName}</span>
                </p>
                <Button variant="ghost" type="button" disabled={busy} onClick={() => void handleCancelPairing()}>
                  Cancel pairing
                </Button>
              </div>
            ) : (
              <p className="text-text-secondary">Nobody is waiting to pair yet. Send /start to your bot first.</p>
            )}
            <form onSubmit={event => void handleConfirm(event)} className="space-y-4">
              <div>
                <label htmlFor="telegram-pairing-code" className={LABEL_CLASS}>
                  Pairing code
                </label>
                <input
                  id="telegram-pairing-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={event => setCode(event.target.value)}
                  placeholder="Six digits"
                  required
                  className={auiInputClass('h-11')}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>{removeControls}</div>
                <Button type="submit" disabled={busy || code.trim() === ''}>
                  {busy ? 'Checking…' : 'Pair'}
                </Button>
              </div>
            </form>
          </div>
        ) : null}

        {status !== null && status.state === 'connected' ? (
          <div className="space-y-4">
            <p>
              Connected as <span className="font-medium">{botLine}</span>.
            </p>
            <p className="text-text-secondary">
              Messages you send the bot land in the Telegram chat here, and replies come back to Telegram. Reminders and
              things that need your ok are sent there too. The bot answers only you.
            </p>
            {removeControls}
          </div>
        ) : null}
      </div>
    </CenteredModal>
  );
}
