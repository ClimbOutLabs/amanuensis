import { CenteredModal, Icon, railMenuRowClassName, type ShellActionsActionSlotProps } from '@truefoundry/trueforge-ui';
import { useEffect, useState } from 'react';
import { getCachedIsOidcConnectedSession, isOidcConnectedSession, logout } from './authSession';
import './LogoutButton.css';
import { UI_BASE_PATH } from './publicPath';

/**
 * Sign out, in the rail's More menu as a labeled row or elsewhere as an icon button (via the
 * `ShellActionsActionSlot` override).
 * Shown only when `auth.me()` returns `data.type: "oidc-connected"`.
 * Uses a module cache so remounts of the action slot do not hide the control during refetches.
 */
export function LogoutButton({ row = false }: ShellActionsActionSlotProps) {
  const [visible, setVisible] = useState(() => getCachedIsOidcConnectedSession() === true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const state = { cancelled: false };
    void isOidcConnectedSession()
      .then(ok => {
        if (!state.cancelled) {
          setVisible(ok);
        }
      })
      .catch(() => {
        // Failed refetch must not clear a known-good session (e.g. transient network).
        if (!state.cancelled && getCachedIsOidcConnectedSession() === undefined) {
          setVisible(false);
        }
      });
    return () => {
      state.cancelled = true;
    };
  }, []);

  if (!visible) {
    return null;
  }

  const handleConfirm = () => {
    if (busy) {
      return;
    }
    setBusy(true);
    void logout()
      .then(() => {
        // Land on the welcome gate under the UI public path (not site root).
        window.location.assign(UI_BASE_PATH);
      })
      .catch(() => {
        setBusy(false);
      });
  };

  return (
    <>
      {row ? (
        <button
          type="button"
          className={railMenuRowClassName}
          onClick={() => {
            setConfirmOpen(true);
          }}
        >
          <Icon name="log-out" size={14} />
          Sign out
        </button>
      ) : (
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          className="harness-logout"
          onClick={() => {
            setConfirmOpen(true);
          }}
        >
          <Icon name="log-out" />
        </button>
      )}

      <CenteredModal
        open={confirmOpen}
        onOpenChange={next => {
          if (!busy) {
            setConfirmOpen(next);
          }
        }}
        title="Sign out?"
        contentSized
      >
        <div className="harness-logout-confirm">
          <button
            type="button"
            className="harness-logout-cancel"
            disabled={busy}
            onClick={() => {
              setConfirmOpen(false);
            }}
          >
            Stay
          </button>
          <button type="button" className="harness-logout-submit" disabled={busy} onClick={handleConfirm}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </CenteredModal>
    </>
  );
}
