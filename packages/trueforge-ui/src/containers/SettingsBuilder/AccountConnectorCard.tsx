'use client';

import { cn } from '@/atoms/lib/cn.js';
import { Button } from '@/atoms/primitives/Button.js';
import type { AccountConnectionState } from '@/server/accountSetup.js';

type AccountConnectorCardProps = {
  /** Used for the section heading id, such as email. */
  id: string;
  title: string;
  /** One character shown in the round badge. */
  glyph: string;
  /** What the connector does, shown while it is not connected. */
  description: string;
  /** The line shown while connected, such as the connected address; null falls back to the description. */
  connectedLine: string | null;
  /** The line shown while the saved sign-in no longer works. */
  stoppedLine: string;
  /** The line shown while the account is saved but its server cannot be reached right now. */
  notWorkingLine: string;
  /** The status pill text when the status could not be read. */
  failedLabel: string;
  state: AccountConnectionState;
  /** True when the last status read failed; the button then retries instead of opening the panel. */
  failed: boolean;
  onOpen: () => void;
  onRetry: () => void;
};

/**
 * The frame every account-based connector (Email, Calendar) shows in Settings, Connectors: a heading,
 * a status pill and one button. The setup form itself lives in each connector's own panel.
 */
export default function AccountConnectorCard({
  id,
  title,
  glyph,
  description,
  connectedLine,
  stoppedLine,
  notWorkingLine,
  failedLabel,
  state,
  failed,
  onOpen,
  onRetry,
}: AccountConnectorCardProps) {
  const connected = state === 'connected';
  const stopped = state === 'sign_in_stopped';
  const notWorking = state === 'not_working';
  const label = failed
    ? failedLabel
    : stopped
      ? 'Sign-in stopped working'
      : notWorking
        ? 'Not working right now'
        : connected
          ? 'Connected'
          : 'Not connected';
  const line =
    connected && connectedLine !== null
      ? connectedLine
      : stopped
        ? stoppedLine
        : notWorking
          ? notWorkingLine
          : description;
  return (
    <section aria-labelledby={`${id}-connector-heading`}>
      <h4 id={`${id}-connector-heading`} className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary">
        {title}
      </h4>
      <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
        <article className="flex min-h-16 w-full items-center gap-3 p-3">
          <span
            className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary-bg text-sm font-semibold text-text-primary"
            aria-hidden
          >
            {glyph}
          </span>
          <div className="min-w-0 flex-1">
            <h5 className="truncate text-sm font-medium text-text-primary">{title}</h5>
            <p className="mt-0.5 line-clamp-2 text-sm text-text-secondary sm:truncate">{line}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                'rounded-full border border-border bg-secondary-bg/40 px-2 py-0.5 text-xs font-medium',
                stopped || notWorking ? 'text-failure-bg' : connected ? 'text-success-bg' : 'text-text-primary',
              )}
            >
              {label}
            </span>
            <Button variant="secondary" size="small" type="button" onClick={failed ? onRetry : onOpen}>
              {failed ? 'Try again' : connected || stopped || notWorking ? 'Manage' : 'Connect'}
            </Button>
          </div>
        </article>
      </div>
    </section>
  );
}
