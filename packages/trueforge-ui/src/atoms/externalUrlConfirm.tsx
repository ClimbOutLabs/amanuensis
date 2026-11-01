'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { Icon } from '../icons/Icon.js';
import { getHostname, isExternalHttpUrl, isTrustedHost, openExternalHttpUrl, trustHost } from './externalUrlTrust.js';
import { cn } from './lib/cn.js';
import { Button } from './primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './primitives/Dialog.js';

type PendingExternalUrl = {
  kind: 'link' | 'image';
  url: string;
};

type ExternalUrlConfirmContextValue = {
  requestLinkConfirm: (url: string) => void;
  requestImageConfirm: (url: string) => void;
  isSessionImageHostTrusted: (host: string) => boolean;
};

const ExternalUrlConfirmContext = createContext<ExternalUrlConfirmContextValue | null>(null);

export function useExternalUrlConfirm(): ExternalUrlConfirmContextValue {
  const value = useContext(ExternalUrlConfirmContext);
  if (value == null) {
    throw new Error('Markdown external URL confirm requires ExternalUrlConfirmProvider');
  }
  return value;
}

/**
 * True for javascript:/data:/vbscript: hrefs (and unparseable ones). Those skip the
 * external-link confirm path, so we block activation instead of letting the browser run them.
 */
function isDangerousNavigationUrl(url: string): boolean {
  try {
    const protocol = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://localhost').protocol;
    return protocol === 'javascript:' || protocol === 'data:' || protocol === 'vbscript:';
  } catch {
    return true;
  }
}

/** Visual half of the "don't ask again" toggle; the wrapping button carries the checkbox role. */
function ConfirmCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
        checked
          ? 'border-primary-button-bg bg-primary-button-bg text-primary-button-text'
          : 'border-input-border bg-input-box-bg',
      )}
      aria-hidden
    >
      {checked ? <Icon name="check" className="size-3" /> : null}
    </span>
  );
}

export function ExternalUrlConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingExternalUrl | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [sessionImageHosts, setSessionImageHosts] = useState(() => new Set<string>());

  const requestLinkConfirm = useCallback((url: string) => {
    setDontAskAgain(false);
    setPending({ kind: 'link', url });
  }, []);

  const requestImageConfirm = useCallback((url: string) => {
    setDontAskAgain(false);
    setPending({ kind: 'image', url });
  }, []);

  const isSessionImageHostTrusted = useCallback(
    (host: string) => sessionImageHosts.has(host.toLowerCase()),
    [sessionImageHosts],
  );

  const close = useCallback(() => {
    setPending(null);
    setDontAskAgain(false);
  }, []);

  const confirm = useCallback(() => {
    if (pending == null) return;
    const host = getHostname(pending.url);
    if (pending.kind === 'link') {
      if (dontAskAgain && host != null) trustHost({ kind: 'links', host });
      openExternalHttpUrl(pending.url);
      close();
      return;
    }
    if (host != null) {
      if (dontAskAgain) trustHost({ kind: 'images', host });
      setSessionImageHosts(prev => {
        const next = new Set(prev);
        next.add(host.toLowerCase());
        return next;
      });
    }
    close();
  }, [close, dontAskAgain, pending]);

  const value = useMemo(
    () => ({
      requestLinkConfirm,
      requestImageConfirm,
      isSessionImageHostTrusted,
    }),
    [isSessionImageHostTrusted, requestImageConfirm, requestLinkConfirm],
  );

  const pendingHost = pending != null ? getHostname(pending.url) : null;
  const title = pending?.kind === 'image' ? 'Show external image' : 'Open external link';
  const description =
    pending?.kind === 'image'
      ? "You're about to load an image from an external site:"
      : "You're leaving this app to visit an external link:";
  const confirmLabel = pending?.kind === 'image' ? 'Show image' : 'Open link';
  const checkboxLabel =
    pendingHost == null
      ? null
      : pending?.kind === 'image'
        ? `Don't ask again for images from ${pendingHost}`
        : `Don't ask again for links to ${pendingHost}`;

  return (
    <ExternalUrlConfirmContext.Provider value={value}>
      {children}
      {pending != null ? (
        <Dialog
          open
          onOpenChange={open => {
            if (!open) close();
          }}
          aria-label={title}
          className="max-w-md"
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <p className="text-sm text-text-secondary">{description}</p>
            </DialogHeader>
            <div
              className="max-h-24 overflow-auto break-all rounded-md bg-secondary-bg px-3 py-2 font-mono text-sm text-text-primary"
              data-testid="aui-external-url-confirm-url"
            >
              {pending.url}
            </div>
            {checkboxLabel != null ? (
              <button
                type="button"
                role="checkbox"
                aria-checked={dontAskAgain}
                className="flex items-start gap-2 text-left text-sm text-text-secondary"
                onClick={() => setDontAskAgain(value => !value)}
              >
                <ConfirmCheckbox checked={dontAskAgain} />
                <span>{checkboxLabel}</span>
              </button>
            ) : null}
          </DialogContent>
          <DialogFooter>
            <Button.Secondary type="button" onClick={close}>
              Cancel
            </Button.Secondary>
            <Button.Primary type="button" onClick={confirm}>
              {confirmLabel}
            </Button.Primary>
          </DialogFooter>
        </Dialog>
      ) : null}
    </ExternalUrlConfirmContext.Provider>
  );
}

export function MarkdownExternalLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const { requestLinkConfirm } = useExternalUrlConfirm();
  const dangerous = href != null && href !== '' && isDangerousNavigationUrl(href);
  const external = href != null && href !== '' && !dangerous && isExternalHttpUrl(href);
  // External destinations never stay in href — middle-click / context-menu bypass onClick.
  // Activation always goes through guardNavigation (trusted hosts skip the dialog there).
  const anchorHref = dangerous ? undefined : external ? '#' : href;

  const guardNavigation = (event: MouseEvent<HTMLAnchorElement>) => {
    if (href == null || href === '') return;
    if (isDangerousNavigationUrl(href)) {
      event.preventDefault();
      return;
    }
    if (!isExternalHttpUrl(href)) return;

    event.preventDefault();
    const host = getHostname(href);
    if (host != null && isTrustedHost({ kind: 'links', host })) {
      openExternalHttpUrl(href);
      return;
    }
    requestLinkConfirm(href);
  };

  return (
    <a
      {...props}
      href={anchorHref}
      target={external || dangerous ? '_blank' : props.target}
      rel="noopener noreferrer"
      onClick={guardNavigation}
      onAuxClick={guardNavigation}
    >
      {children}
    </a>
  );
}
