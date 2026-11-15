'use client';

import { useState, type FormEvent } from 'react';

import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { useOptionalLocalAccount } from '@/components/LocalAccountContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

const LABEL_CLASS = 'mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary';
const PASSWORDS_DO_NOT_MATCH_LINE = 'The two passwords do not match. Type the new password twice, the same both times.';
const CHANGED_LINE = 'Your password is changed. Other devices are signed out.';

/**
 * Settings, Account: change the password for the local sign-in. Shown only when the host
 * provides the local account surface, which happens only for local sign-in.
 */
const AccountSettings = () => {
  const account = useOptionalLocalAccount();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordAgain, setNewPasswordAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  if (account === null) {
    return null;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    setError(null);
    setChanged(false);
    if (newPassword !== newPasswordAgain) {
      setError(PASSWORDS_DO_NOT_MATCH_LINE);
      return;
    }
    setBusy(true);
    try {
      await account.changePassword({ current_password: currentPassword, new_password: newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setNewPasswordAgain('');
      setChanged(true);
    } catch (cause) {
      setError(getErrorMessage(cause, 'Your password could not be changed. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Account</h2>
        <p className="mt-1 text-sm text-text-secondary">
          This Aman signs you in with an email and a password it keeps itself. There is only one sign-in, and it can
          change every setting.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card-bg p-4">
        <h3 className="text-sm font-semibold text-text-primary">Change password</h3>
        <form onSubmit={event => void handleSubmit(event)} className="mt-4 space-y-4">
          <div>
            <label htmlFor="account-current-password" className={LABEL_CLASS}>
              Current password
            </label>
            <input
              id="account-current-password"
              type="password"
              value={currentPassword}
              onChange={event => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
              className={auiInputClass('h-11')}
            />
          </div>
          <div>
            <label htmlFor="account-new-password" className={LABEL_CLASS}>
              New password
            </label>
            <input
              id="account-new-password"
              type="password"
              value={newPassword}
              onChange={event => setNewPassword(event.target.value)}
              autoComplete="new-password"
              required
              className={auiInputClass('h-11')}
            />
            <p className="mt-1 text-text-secondary">At least 8 characters.</p>
          </div>
          <div>
            <label htmlFor="account-new-password-again" className={LABEL_CLASS}>
              Type the new password again
            </label>
            <input
              id="account-new-password-again"
              type="password"
              value={newPasswordAgain}
              onChange={event => setNewPasswordAgain(event.target.value)}
              autoComplete="new-password"
              required
              className={auiInputClass('h-11')}
            />
          </div>
          {error !== null ? (
            <p
              role="alert"
              className="rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg"
            >
              {error}
            </p>
          ) : null}
          {changed ? (
            <p role="status" className="text-sm text-text-primary">
              {CHANGED_LINE}
            </p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
        </form>
      </div>
    </div>
  );
};

export default AccountSettings;
