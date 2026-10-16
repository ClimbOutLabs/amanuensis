'use client';

import type { FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { Icon } from '../icons/Icon.js';
import type { SentinelApprovalCard } from './types.js';

export type HeldActionStatus =
  | { kind: 'waiting' }
  | { kind: 'working' }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

export type HeldActionCardProps = {
  card: SentinelApprovalCard;
  status: HeldActionStatus;
  /** Show "Always allow": the server only accepts it for some tools. */
  alwaysAllowOffered: boolean;
  /** Lets a person who cannot manage this chat read the card without answering it. */
  disabled?: boolean;
  /** A host-written line saying where the action came from; the card shows it first when present. */
  provenance?: string | null | undefined;
  onApprove: () => void;
  onAlwaysAllow: () => void;
  onDeny: () => void;
};

export const HELD_EXPIRED_TEXT = 'Expired, nothing was done. Ask again in chat.';

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm sm:flex-row sm:items-baseline sm:gap-2">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary sm:w-20">{label}</dt>
      <dd className={`min-w-0 break-words text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function StatusLine({ status }: { status: Exclude<HeldActionStatus, { kind: 'waiting' }> }) {
  switch (status.kind) {
    case 'working':
      return <p className="text-sm text-text-secondary">Working on it...</p>;
    case 'approved':
      return (
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Icon name="circle-check" className="shrink-0 text-success-bg" aria-hidden="true" />
          Approved.
        </p>
      );
    case 'denied':
      return (
        <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Icon name="circle-xmark" className="shrink-0 text-failure-bg" aria-hidden="true" />
          Denied. Nothing was done.
        </p>
      );
    case 'expired':
      return <p className="text-sm text-text-secondary">{HELD_EXPIRED_TEXT}</p>;
    case 'failed':
      return (
        <p role="alert" className="text-sm text-failure-bg">
          {status.message}
        </p>
      );
  }
}

/**
 * One action a scheduled run held for its owner. Written for someone who was not there when the
 * model decided: what will happen, to whom, and the exact text come from the server, and the
 * model's own reason is shown last because it is the model's word, not a checked fact.
 */
export const HeldActionCard: FC<HeldActionCardProps> = ({
  card,
  status,
  alwaysAllowOffered,
  disabled = false,
  provenance,
  onApprove,
  onAlwaysAllow,
  onDeny,
}) => {
  const hasDetails =
    card.recipient !== null ||
    card.destination !== null ||
    card.destination_host !== null ||
    card.amount !== null ||
    card.parsed_command !== null;
  const canAnswer = status.kind === 'waiting' || status.kind === 'failed';

  return (
    <li className="list-none rounded-lg border border-border bg-primary-bg" data-role="held-action">
      <div className="space-y-3 px-4 py-3">
        {provenance != null && provenance !== '' && (
          <p className="text-xs text-text-secondary" data-role="held-action-provenance">
            {provenance}
          </p>
        )}
        <p className="text-sm font-medium text-text-primary">{card.plain_what}</p>

        {hasDetails && (
          <dl className="space-y-1.5 rounded border border-border bg-secondary-bg px-3 py-2">
            {card.recipient !== null && <DetailRow label="To" value={card.recipient} />}
            {card.destination !== null && <DetailRow label="Where" value={card.destination} mono />}
            {card.destination_host !== null && <DetailRow label="Sends to" value={card.destination_host} mono />}
            {card.amount !== null && <DetailRow label="Amount" value={card.amount} mono />}
            {card.parsed_command !== null && <DetailRow label="Command" value={card.parsed_command} mono />}
          </dl>
        )}

        {card.outbound_text !== null && (
          <div className="rounded border border-border bg-secondary-bg px-3 py-2">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">
              Exactly what will be sent
            </p>
            {card.outbound_truncated && (
              <p className="mb-1 text-sm font-medium text-text-primary" data-role="held-action-truncated">
                Part of this is not shown in full. Check it before you approve.
              </p>
            )}
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-primary">
              {card.outbound_text}
            </pre>
          </div>
        )}

        {card.cannot_be_undone !== null && (
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <Icon name="info" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{card.cannot_be_undone}</span>
          </p>
        )}

        {card.plain_why !== null && (
          <p className="text-sm text-text-secondary" data-role="held-action-reason">
            Aman&apos;s reason: {card.plain_why}
          </p>
        )}

        {status.kind !== 'waiting' && <StatusLine status={status} />}

        {canAnswer && (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button variant="primary" size="large" onClick={onApprove} disabled={disabled} className="sm:min-w-24">
              Approve
            </Button>
            {alwaysAllowOffered && (
              <Button variant="secondary" size="large" onClick={onAlwaysAllow} disabled={disabled}>
                Always allow
              </Button>
            )}
            <Button variant="secondary" size="large" onClick={onDeny} disabled={disabled} className="sm:min-w-24">
              Deny
            </Button>
          </div>
        )}
      </div>
    </li>
  );
};
