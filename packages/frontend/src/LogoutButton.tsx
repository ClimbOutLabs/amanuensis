import {
  CenteredModal,
  Icon,
  menuTriggerFor,
  railMenuRowClassName,
  type ShellActionsActionSlotProps,
} from '@truefoundry/trueforge-ui';
import { createContext, use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getCachedIsOidcConnectedSession, isOidcConnectedSession, logout } from './authSession';
import './LogoutButton.css';
import { UI_BASE_PATH } from './publicPath';

/** Opens the "Sign out?" question. `returnFocusTo` gets the keyboard back if the person stays. */
type AskToSignOut = (returnFocusTo: HTMLElement) => void;

const SignOutConfirmContext = createContext<AskToSignOut | null>(null);

/**
 * Owns the "Sign out?" question, mounted once around the shell. The button that asks sits in a menu
 * that closes on the click, so the question cannot live inside the button.
 */
export function SignOutConfirmProvider({ children }: { children: ReactNode }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const ask = useCallback<AskToSignOut>(returnFocusTo => {
    returnFocusRef.current = returnFocusTo;
    setConfirmOpen(true);
  }, []);

  // Runs after the question has closed, when the page behind it can take focus again.
  useEffect(() => {
    if (confirmOpen) {
      return;
    }
    const returnTo = returnFocusRef.current;
    returnFocusRef.current = null;
    if (returnTo?.isConnected === true) {
      returnTo.focus();
    }
  }, [confirmOpen]);

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
    <SignOutConfirmContext value={ask}>
      {children}
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
    </SignOutConfirmContext>
  );
}

/**
 * Sign out, in the rail's More menu as a labeled row or elsewhere as an icon button (via the
 * `ShellActionsActionSlot` override).
 * Shown only when `auth.me()` returns a browser sign-in type (`"oidc-connected"` or `"local-connected"`).
 * Uses a module cache so remounts of the action slot do not hide the control during refetches.
 */
export function LogoutButton({ row = false }: ShellActionsActionSlotProps) {
  const ask = use(SignOutConfirmContext);
  const [visible, setVisible] = useState(() => getCachedIsOidcConnectedSession() === true);

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

  if (ask === null) {
    throw new Error('LogoutButton must be rendered inside SignOutConfirmProvider.');
  }
  if (!visible) {
    return null;
  }

  return row ? (
    <button
      type="button"
      className={railMenuRowClassName}
      onClick={event => {
        ask(menuTriggerFor(event.currentTarget));
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
      onClick={event => {
        ask(menuTriggerFor(event.currentTarget));
      }}
    >
      <Icon name="log-out" />
    </button>
  );
}
