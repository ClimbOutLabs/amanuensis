'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { HelpStuckButton } from '../help/HelpStuckButton.js';
import { rememberErrorText } from '../help/lastError.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { getErrorMessage } from '../utils/getErrorMessage.js';
import { EXPIRED_REQUEST_DESCRIPTION, EXPIRED_REQUEST_TITLE, isStaleApprovalError } from '../utils/staleApproval.js';
import {
  DAILY_BUDGET_DESCRIPTION,
  DAILY_BUDGET_TITLE,
  isTokenFactoryDailyCapError,
} from '../utils/tokenFactoryBudget.js';

const MAX_TOAST_DESCRIPTION_CHARS = 480;
const MAX_VISIBLE_TOASTS = 5;
const SUCCESS_TOAST_TTL_MS = 3000;

type ToastContent = { title: string; description?: string };

type ToastItem = ToastContent & { id: string; variant: 'error' | 'success' };

type ToasterContextValue = {
  /** `title` replaces the generic heading when the caller knows what the person was doing. */
  showError: (error: unknown, options?: { title: string }) => void;
  showSuccess: (content: ToastContent) => void;
};

const ToasterContext = createContext<ToasterContextValue | null>(null);

let toastId = 0;
function nextToastId(): string {
  toastId += 1;
  return `toast-${toastId}`;
}

function truncateDescription(text: string): string {
  if (text.length <= MAX_TOAST_DESCRIPTION_CHARS) return text;
  return `${text.slice(0, MAX_TOAST_DESCRIPTION_CHARS - 1)}…`;
}

function isHttpLikeError(error: unknown): error is Error & { statusCode?: number; body?: unknown } {
  return error instanceof Error && ('statusCode' in error || 'body' in error);
}

function normalizeError(error: unknown, options?: { trustPageUrl?: string }): ToastContent {
  if (isStaleApprovalError(error)) {
    return { title: EXPIRED_REQUEST_TITLE, description: EXPIRED_REQUEST_DESCRIPTION };
  }
  if (isTokenFactoryDailyCapError(error)) {
    return { title: DAILY_BUDGET_TITLE, description: DAILY_BUDGET_DESCRIPTION };
  }
  if (isHttpLikeError(error)) {
    const statusCode = error.statusCode;
    if (statusCode != null || error.body != null) {
      const title = statusCode != null ? `Request failed (${statusCode})` : 'Request failed';
      const raw = getErrorMessage(error, 'The server returned an error.');
      return { title, description: truncateDescription(raw) };
    }
  }

  // A dropped transport (sleeping phone, network change) is not a mystery, and neither is a device
  // that does not trust this computer's certificate yet: the browser reports both the same way,
  // so the words name the checks for both.
  const message = getErrorMessage(error, '');
  if (isNetworkFailureMessage(message)) {
    const trustPageUrl = options?.trustPageUrl;
    return {
      title: 'Connection lost',
      description:
        trustPageUrl !== undefined && trustPageUrl !== ''
          ? `Check your connection, then reload the page. If it still cannot connect, this device may not trust this computer yet: open ${trustPageUrl} on this device and follow its steps.`
          : 'Check your connection, then reload the page. If it still cannot connect, this device may not trust this computer yet: open the /trust page on this device and follow its steps.',
    };
  }

  return {
    title: 'Something went wrong',
    description: truncateDescription(getErrorMessage(error, 'An unexpected error occurred.')),
  };
}

/** Matches the DOMException/TypeError text browsers use for failed fetches. */
function isNetworkFailureMessage(message: string): boolean {
  return (
    message === 'Failed to fetch' ||
    message === 'NetworkError when attempting to fetch resource.' ||
    message === 'Load failed' ||
    /network request failed/i.test(message)
  );
}

export function ToasterProvider({ children, trustPageUrl }: { children: ReactNode; trustPageUrl?: string }) {
  const Toast = useSlot('Toast');
  const ToastStack = useSlot('ToastStack');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const showError = useCallback(
    (error: unknown, options?: { title: string }) => {
      console.error('[trueforge-ui]', error);
      const content = normalizeError(error, { trustPageUrl });
      const item: ToastItem = {
        id: nextToastId(),
        variant: 'error',
        ...content,
        ...(options === undefined ? {} : { title: options.title }),
      };
      rememberErrorText([item.title, item.description].filter(Boolean).join(': '));
      setToasts(prev => [...prev, item].slice(-MAX_VISIBLE_TOASTS));
    },
    [trustPageUrl],
  );

  const showSuccess = useCallback(
    (content: ToastContent) => {
      const id = nextToastId();
      const item: ToastItem = { id, variant: 'success', ...content };
      setToasts(prev => [...prev, item].slice(-MAX_VISIBLE_TOASTS));
      // Success is a transient confirmation — auto-dismiss so it doesn't linger. Errors persist
      // (a dev may need to read or copy them).
      if (typeof window !== 'undefined') {
        window.setTimeout(() => dismiss(id), SUCCESS_TOAST_TTL_MS);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => ({ showError, showSuccess }), [showError, showSuccess]);

  return (
    <ToasterContext.Provider value={value}>
      {children}
      <ToastStack>
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            title={toast.title}
            description={toast.description ?? ''}
            variant={toast.variant}
            action={toast.variant === 'error' ? <HelpStuckButton /> : undefined}
            open
            onOpenChange={open => {
              if (!open) dismiss(toast.id);
            }}
          />
        ))}
      </ToastStack>
    </ToasterContext.Provider>
  );
}

export function useToaster(): ToasterContextValue {
  const context = useContext(ToasterContext);
  if (context == null) {
    throw new Error('useToaster must be used within ToasterProvider');
  }
  return context;
}

/** Same as `useToaster`, but returns `null` instead of throwing outside `ToasterProvider`. */
export function useToasterOptional(): ToasterContextValue | null {
  return useContext(ToasterContext);
}
