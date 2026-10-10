'use client';

import type { FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { Icon } from '../icons/Icon.js';
import type { SentinelApprovalCard } from './types.js';

type ApprovalCardTier = 2 | 3;

const TIER_LABELS: Record<ApprovalCardTier, string> = { 2: 'Needs your OK', 3: 'Review carefully' };

export type PermissionApprovalCardProps = {
  toolName: string;
  card: SentinelApprovalCard;
  /** Tier the server sent; it only changes the badge, never the controls. */
  tier: ApprovalCardTier;
  onApprove: () => void;
  onDeny: () => void;
  /**
   * Approves every pending Tier 2 call in one step. Only the container passes it, and
   * only for a Tier 2 card with other Tier 2 calls waiting; Tier 3 never gets it.
   */
  onApproveAll?: (() => void) | undefined;
  /** How many Tier 2 calls "Approve all" covers, shown on its button. */
  batchSize?: number | undefined;
  disabled?: boolean;
};

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-text-primary break-all' : 'text-text-primary'}>{value}</dd>
    </div>
  );
}

/**
 * Plain-language approval card for Tier 3 actions and Tier 2 actions that ask. Every row renders only what the server sent:
 * `plain_what` is always present, everything else renders when non-null. The parsed
 * command renders whenever the card carries one; the server only attaches it to shell
 * cards, so the card never needs to know which tool it is. The card never infers the
 * tier; the container only mounts it for an explicit Tier 2 or Tier 3 approval.
 */
export const PermissionApprovalCard: FC<PermissionApprovalCardProps> = ({
  toolName,
  card,
  tier,
  onApprove,
  onDeny,
  onApproveAll,
  batchSize,
  disabled = false,
}) => {
  const hasDetails =
    card.destination !== null || card.recipient !== null || card.amount !== null || card.parsed_command !== null;

  return (
    <div className="rounded-lg border border-primary-button-bg/30 bg-primary-button-bg/10">
      <div className="flex items-center justify-between gap-3 rounded-t-lg border-b border-primary-button-bg/30 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="lock" className="shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="truncate text-sm font-semibold text-text-primary">Permission needed</span>
          <span className="min-w-0 truncate rounded bg-primary-bg px-1.5 py-0.5 font-mono text-xs text-text-secondary">
            {toolName}
          </span>
        </div>
        <span className="shrink-0 rounded border border-primary-button-bg/40 bg-primary-bg px-2 py-0.5 text-[0.6875rem] font-medium text-text-secondary">
          {TIER_LABELS[tier]}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <p className="text-sm text-text-primary">{card.plain_what}</p>
        {card.plain_why !== null && <p className="text-sm text-text-secondary">{card.plain_why}</p>}

        {card.cannot_be_undone !== null && (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-warning-bg/40 bg-warning-bg/10 px-3 py-2 text-sm text-text-primary"
          >
            <Icon name="triangle-exclamation" className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Cannot be undone: {card.cannot_be_undone}</span>
          </p>
        )}

        {card.why_asked_again !== null && (
          <p className="text-xs text-text-secondary">You have seen this before: {card.why_asked_again}</p>
        )}

        {hasDetails && (
          <dl className="space-y-1.5 rounded border border-border bg-primary-bg px-3 py-2">
            {card.destination !== null && <DetailRow label="Destination" value={card.destination} mono />}
            {card.recipient !== null && <DetailRow label="Recipient" value={card.recipient} />}
            {card.amount !== null && <DetailRow label="Amount" value={card.amount} mono />}
            {card.parsed_command !== null && <DetailRow label="Command" value={card.parsed_command} mono />}
          </dl>
        )}

        <div className="flex gap-2">
          <Button variant="primary" size="small" onClick={onApprove} disabled={disabled} className="flex-1">
            Approve
          </Button>
          <Button variant="secondary" size="small" onClick={onDeny} disabled={disabled} className="flex-1">
            Deny
          </Button>
        </div>
        {onApproveAll !== undefined && (
          <Button variant="secondary" size="small" onClick={onApproveAll} disabled={disabled} className="w-full">
            {batchSize === undefined ? 'Approve all' : `Approve all (${String(batchSize)})`}
          </Button>
        )}
      </div>
    </div>
  );
};
