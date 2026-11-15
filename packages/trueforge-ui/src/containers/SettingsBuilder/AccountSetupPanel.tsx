'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import type { AccountConnectionState } from '@/server/accountSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

/** One saved account, as the connected view lists it for kinds that can hold several. */
export interface PanelAccount {
  key: string;
  label: string;
  state: AccountConnectionState;
  isDefault: boolean;
}

type AccountSetupPanelProps<TStatus extends { state: AccountConnectionState }> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after anything that changes the connection, so the list can refresh. */
  onChanged: () => void;
  title: string;
  description: string;
  /** What the account is called in buttons and sentences, such as account or calendar. */
  thing: string;
  /** Where the app password is kept, such as the email connector. */
  connector: string;
  loadStatus: () => Promise<TStatus>;
  /** Saves what the form holds. The kind clears its password field whatever the answer is. */
  saveAccount: () => Promise<TStatus>;
  removeAccount: () => Promise<TStatus>;
  /** Called each time the panel opens, before its status is read. */
  onOpened: () => void;
  /** Called with every status the panel receives, so the form fields follow it, and reset when none is saved. */
  onStatus: (status: TStatus) => void;
  /** Who the account is, shown after "Connected as". */
  connectedAs: (status: TStatus) => string | null;
  /** Whether the form holds enough to try a save. */
  canSubmit: boolean;
  /** The provider-specific fields. */
  fields: (status: TStatus) => ReactNode;
  /** Every saved account, for kinds that can hold several; the connected view lists them instead. */
  listAccounts?: ((status: TStatus) => readonly PanelAccount[]) | undefined;
  /** Starts the form for one listed account, or with null for a new one; the kind fills its fields. */
  beginEdit?: ((key: string | null) => void) | undefined;
  /** Makes one listed account the default. */
  makeDefault?: ((key: string) => Promise<TStatus>) | undefined;
  /** Removes one listed account. */
  removeOne?: ((key: string) => Promise<TStatus>) | undefined;
  /** The line over the form, replacing the standard saved/checked lines for list kinds. */
  saveNote?: string | undefined;
  /** Shown under the panel's content in every state, such as what the assistant can do once connected. */
  note?: ReactNode;
};

const STOPPED_LINE = 'Sign-in stopped working. Make a new app password and save it again.';

/**
 * The setup panel every account-based connector (Email, Calendar) shows in Settings, Connectors: loading the
 * status, the saved-account summary, the form frame, and Remove. A connector supplies only its own fields.
 * The app password is typed in the connector's fields and nowhere else: it goes straight to the server
 * endpoint and is never shown back. Remove and Cancel are offered in every saved state, so an account whose
 * sign-in stopped or whose server is down can still be removed.
 */
export default function AccountSetupPanel<TStatus extends { state: AccountConnectionState }>({
  open,
  onOpenChange,
  onChanged,
  title,
  description,
  thing,
  connector,
  loadStatus,
  saveAccount,
  removeAccount,
  onOpened,
  onStatus,
  connectedAs,
  canSubmit,
  fields,
  listAccounts,
  beginEdit,
  makeDefault,
  removeOne,
  saveNote,
  note,
}: AccountSetupPanelProps<TStatus>) {
  const [status, setStatus] = useState<TStatus | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback(
    (next: TStatus) => {
      setStatus(next);
      // List kinds open on the list whenever anything is saved, so one stopped account cannot
      // hide the others; single-account kinds open on the form until the account connects.
      setShowForm(listAccounts === undefined ? next.state !== 'connected' : next.state === 'not_connected');
      setConfirmingRemove(false);
      setConfirmingKey(null);
      onStatus(next);
    },
    [onStatus, listAccounts],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    onOpened();
    let cancelled = false;
    void loadStatus()
      .then(next => {
        if (!cancelled) {
          applyStatus(next);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(caught, `Couldn't check your ${thing} just now. Try again.`));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, loadStatus, applyStatus, onOpened, thing]);

  const connected = status?.state === 'connected';
  const saved = status !== null && status.state !== 'not_connected';
  // List kinds show the form only when it was asked for, so a saved account in a stopped or
  // not-working state still lands on its list; single-account kinds show it until connected.
  const formShown = listAccounts === undefined ? !connected || showForm : showForm;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      applyStatus(await saveAccount());
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, `Couldn't save that ${thing}. Try again.`));
      // A save that was cut off may still have gone through, so the list asks again.
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await removeAccount());
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, `Couldn't remove that ${thing}. Try again.`));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleMakeDefault = async (key: string) => {
    if (makeDefault === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applyStatus(await makeDefault(key));
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, `Couldn't change the default ${thing}. Try again.`));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveOne = async (key: string) => {
    if (removeOne === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      applyStatus(await removeOne(key));
      onChanged();
    } catch (caught) {
      setError(getErrorMessage(caught, `Couldn't remove that ${thing}. Try again.`));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleBeginEdit = (key: string | null) => {
    beginEdit?.(key);
    setError(null);
    setShowForm(true);
  };

  const removeControls = confirmingRemove ? (
    <div className="flex flex-wrap items-center gap-2">
      <p className="w-full text-text-secondary">Remove this {thing}? The saved app password is deleted for good.</p>
      <Button type="button" disabled={busy} onClick={() => void handleRemove()}>
        Remove {thing}
      </Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(false)}>
        Keep it
      </Button>
    </div>
  ) : (
    <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingRemove(true)}>
      Remove
    </Button>
  );

  return (
    <CenteredModal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      className="md:max-w-2xl"
    >
      <div className="space-y-5 px-5 py-5 text-sm text-text-primary">
        {error ? (
          <p role="alert" className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg">
            {error}
          </p>
        ) : null}

        {status === null && error === null ? <p className="text-text-secondary">Checking…</p> : null}

        {status !== null && !showForm && listAccounts !== undefined && listAccounts(status).length > 0 ? (
          <div className="space-y-4">
            <div className="space-y-3">
              {listAccounts(status).map(account => (
                <div key={account.key} className="rounded-md border border-border px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{account.label}</span>
                    {account.isDefault ? (
                      <span className="rounded-full bg-bg-secondary px-2 py-0.5 text-xs text-text-secondary">
                        Default
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-text-secondary">
                    {account.state === 'connected'
                      ? 'Connected.'
                      : account.state === 'sign_in_stopped'
                        ? 'Sign-in stopped working. Change it to save a new app password.'
                        : account.state === 'not_working'
                          ? 'Saved, but not working right now.'
                          : ''}
                  </p>
                  {confirmingKey === account.key ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="w-full text-text-secondary">
                        Remove this {thing}? The saved app password is deleted for good.
                      </p>
                      <Button type="button" disabled={busy} onClick={() => void handleRemoveOne(account.key)}>
                        Remove {thing}
                      </Button>
                      <Button variant="ghost" type="button" disabled={busy} onClick={() => setConfirmingKey(null)}>
                        Keep it
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!account.isDefault && makeDefault !== undefined ? (
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleMakeDefault(account.key)}
                        >
                          Make default
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => handleBeginEdit(account.key)}
                      >
                        Change
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmingKey(account.key)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <Button variant="secondary" type="button" disabled={busy} onClick={() => handleBeginEdit(null)}>
              Add another {thing}
            </Button>
            <p className="text-text-secondary">
              App passwords are saved only on this computer, in the {connector}. They are never shown again.
            </p>
          </div>
        ) : null}

        {status !== null &&
        connected &&
        !showForm &&
        (listAccounts === undefined || listAccounts(status).length === 0) ? (
          <div className="space-y-4">
            <p>
              Connected as <span className="font-medium">{connectedAs(status)}</span>.
            </p>
            <p className="text-text-secondary">
              The app password is saved only on this computer, in the {connector}. It is never shown again.
            </p>
            {confirmingRemove ? (
              removeControls
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" type="button" onClick={() => setShowForm(true)}>
                  Change {thing}
                </Button>
                {removeControls}
              </div>
            )}
          </div>
        ) : null}

        {status !== null && formShown ? (
          <form onSubmit={event => void handleSave(event)} className="space-y-4">
            {status.state === 'sign_in_stopped' ? (
              <p
                role="alert"
                className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg"
              >
                {STOPPED_LINE}
              </p>
            ) : null}
            {status.state === 'not_working' ? (
              <p
                role="alert"
                className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-failure-bg"
              >
                This {thing} is saved, but it is not working right now. Check your internet connection, or type the
                details again.
              </p>
            ) : null}
            {saveNote !== undefined ? (
              <p className="text-text-secondary">{saveNote}</p>
            ) : saved ? (
              <p className="text-text-secondary">
                Saving replaces the saved {thing}. The sign-in is checked before anything is saved.
              </p>
            ) : (
              <p className="text-text-secondary">The sign-in is checked before anything is saved.</p>
            )}
            {fields(status)}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>{saved && listAccounts === undefined ? removeControls : null}</div>
              <div className="flex gap-2">
                {saved ? (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => (connected ? setShowForm(false) : onOpenChange(false))}
                  >
                    Cancel
                  </Button>
                ) : null}
                <Button type="submit" disabled={busy || !canSubmit}>
                  {busy ? 'Checking…' : 'Connect'}
                </Button>
              </div>
            </div>
          </form>
        ) : null}
        {note}
      </div>
    </CenteredModal>
  );
}
