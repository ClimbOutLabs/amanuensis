'use client';

import { useId } from 'react';

import { Icon } from '../icons/Icon.js';
import { StepIconBox } from './agent-chat/StepIconBox.js';
import { cn } from './lib/cn.js';
import { Button } from './primitives/Button.js';

export type ApprovalOption = {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'destructive';
  requiresReason?: boolean;
  grants?: readonly string[];
  confirm?: {
    title?: string;
    description?: string;
  };
};

export type ToolApprovalBarProps = {
  toolName: string;
  guidance?: string;
  hostObservedTargetSummary?: string;
  approveOptions?: ApprovalOption[];
  denyOptions?: ApprovalOption[];
  onSelect: (optionId: string, reason?: string) => void;
  status?: {
    type: 'approved' | 'denied';
    label?: string;
    reason?: string;
  };
  selectedDenyOption?: ApprovalOption;
  denialReason?: string;
  showReasonError?: boolean;
  onDenyOptionChange?: (optionId: string | null) => void;
  onDenialReasonChange?: (reason: string) => void;
  onReasonSubmit?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  showLineBelow?: boolean;
  dataTestPrefix?: string;
  className?: string;
};

const DEFAULT_APPROVE_OPTIONS: ApprovalOption[] = [{ id: 'approve', label: 'Approve', variant: 'primary' }];

const DEFAULT_DENY_OPTIONS: ApprovalOption[] = [
  { id: 'deny', label: 'Deny', variant: 'secondary', requiresReason: true },
];

export function ToolApprovalBar({
  toolName,
  guidance,
  hostObservedTargetSummary,
  approveOptions = DEFAULT_APPROVE_OPTIONS,
  denyOptions = DEFAULT_DENY_OPTIONS,
  onSelect,
  status,
  selectedDenyOption,
  denialReason = '',
  showReasonError = false,
  onDenyOptionChange,
  onDenialReasonChange,
  onReasonSubmit,
  disabled = false,
  readOnly = false,
  showLineBelow = false,
  dataTestPrefix,
  className,
}: ToolApprovalBarProps) {
  const optionGroupName = useId();
  const isDecided = !!status;
  const isApproved = status?.type === 'approved';
  const isDenied = status?.type === 'denied';
  const interactionsLocked = disabled && !isDecided;

  const headingText = isApproved ? 'Tool Approved' : isDenied ? 'Tool Approval Denied' : 'Tool Approval Required for';

  return (
    <div
      className={cn('aui-tool-approval-bar', className)}
      data-testid={dataTestPrefix ? `${dataTestPrefix}-approval` : undefined}
    >
      <div className="flex gap-2">
        <div className={cn('flex shrink-0 flex-col items-center', !showLineBelow && 'pb-1')}>
          <div className="min-h-[0.75rem] w-px flex-1 bg-border" />
          <StepIconBox icon="wrench" variant="muted" iconSize="0.875em" className="my-1" />
          {showLineBelow && <div className="min-h-[0.75rem] w-px flex-1 bg-border" />}
        </div>

        <div className="mt-2 min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3 rounded-t-lg border border-primary-button-bg/30 bg-primary-button-bg/10 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-sans text-sm font-medium text-primary-button-bg">{headingText}</span>
              <span className="min-w-0 truncate rounded bg-primary-bg px-1.5 py-0.5 text-xs text-text-secondary">
                {toolName}
              </span>
            </div>
            {isDecided ? (
              <div className="flex h-fit shrink-0 items-center gap-1 rounded border border-primary-button-bg/40 bg-primary-bg px-2 py-0.5 text-[0.6875rem] font-medium text-text-secondary">
                <Icon
                  name={isDenied ? 'circle-xmark' : 'circle-check'}
                  size="0.875em"
                  className={cn('shrink-0', isDenied ? 'text-failure-bg' : 'text-success-bg')}
                />
                <span className="leading-tight">{status.label ?? (isDenied ? 'Denied' : 'Approved')}</span>
              </div>
            ) : readOnly ? (
              <div className="flex h-fit shrink-0 items-center rounded border border-primary-button-bg/40 bg-primary-bg px-2 py-0.5 text-[0.6875rem] font-medium text-text-secondary">
                <span className="leading-tight">Awaiting decision</span>
              </div>
            ) : selectedDenyOption ? (
              <Button
                size="small"
                variant="secondary"
                disabled={interactionsLocked}
                onClick={() => onDenyOptionChange?.(null)}
              >
                Back
              </Button>
            ) : null}
          </div>

          <div className="rounded-b-lg border border-t-0 border-border px-4 py-3">
            {!isDecided && !selectedDenyOption && guidance ? (
              <p className="mb-3 font-sans text-xs leading-relaxed text-text-secondary">{guidance}</p>
            ) : null}

            {!isDecided && !selectedDenyOption && hostObservedTargetSummary ? (
              <div
                className="mb-3 rounded border border-border bg-secondary-bg px-3 py-2"
                data-testid="host-observed-target"
              >
                <div className="font-sans text-[0.6875rem] font-medium uppercase tracking-wide text-text-secondary">
                  Host-observed target
                </div>
                <p className="mt-1 break-words font-mono text-[0.6875rem] leading-relaxed text-text-primary">
                  {hostObservedTargetSummary}
                </p>
              </div>
            ) : null}

            {!isDecided && !readOnly && !selectedDenyOption && (
              <div className="flex flex-col gap-3" role="radiogroup" aria-label={`Approval options for ${toolName}`}>
                {approveOptions.map(option => (
                  <label
                    key={option.id}
                    className={cn(
                      'flex w-fit items-start gap-x-2 overflow-visible',
                      interactionsLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                    )}
                  >
                    <input
                      type="radio"
                      name={optionGroupName}
                      value={option.id}
                      disabled={interactionsLocked}
                      checked={false}
                      onChange={() => {
                        if (!interactionsLocked) onSelect(option.id);
                      }}
                      className="mt-0.5 accent-primary-button-bg"
                    />
                    <span className="min-w-0 font-sans text-[0.8125rem] font-medium leading-snug text-text-primary">
                      {option.label}
                    </span>
                  </label>
                ))}
                {denyOptions.map(option => (
                  <label
                    key={option.id}
                    className={cn(
                      'flex w-fit items-start gap-x-2 overflow-visible',
                      interactionsLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                    )}
                  >
                    <input
                      type="radio"
                      name={optionGroupName}
                      value={option.id}
                      disabled={interactionsLocked}
                      checked={false}
                      onChange={() => {
                        if (interactionsLocked) return;
                        if (option.requiresReason) {
                          onDenyOptionChange?.(option.id);
                        } else {
                          onSelect(option.id);
                        }
                      }}
                      className="mt-0.5 accent-primary-button-bg"
                    />
                    <span
                      className={cn(
                        'min-w-0 font-sans text-[0.8125rem] font-medium leading-snug',
                        option.variant === 'destructive' ? 'text-failure-bg' : 'text-text-primary',
                      )}
                    >
                      {option.label}
                    </span>
                  </label>
                ))}
              </div>
            )}

            {!isDecided && readOnly && (
              <span className="font-sans text-[0.8125rem] text-text-secondary">No approval decision was recorded.</span>
            )}

            {!isDecided && !readOnly && selectedDenyOption && (
              <div className="flex flex-col gap-2">
                {(selectedDenyOption.confirm?.title || selectedDenyOption.confirm?.description) && (
                  <div className="flex flex-col gap-0.5">
                    {selectedDenyOption.confirm.title && (
                      <span className="text-xs font-medium text-text-primary">{selectedDenyOption.confirm.title}</span>
                    )}
                    {selectedDenyOption.confirm.description && (
                      <span className="text-xs text-text-secondary">{selectedDenyOption.confirm.description}</span>
                    )}
                  </div>
                )}
                {selectedDenyOption.grants && selectedDenyOption.grants.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-xs text-text-secondary">Grants:</span>
                    {selectedDenyOption.grants.map(grant => (
                      <span key={grant} className="rounded bg-secondary-bg px-1.5 py-0.5 text-xs text-text-secondary">
                        {grant}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    placeholder="Enter reason for denial"
                    aria-label="Reason for denial"
                    aria-invalid={showReasonError || undefined}
                    aria-describedby={showReasonError ? 'aui-denial-reason-error' : undefined}
                    value={denialReason}
                    disabled={interactionsLocked}
                    onChange={e => onDenialReasonChange?.(e.target.value)}
                    className={cn(
                      'h-8 flex-1 rounded border border-input-border bg-primary-bg px-2 text-xs text-text-primary',
                      'focus:outline-none focus:ring-1 focus:ring-focus-ring',
                    )}
                  />
                  <Button size="small" disabled={interactionsLocked} onClick={onReasonSubmit}>
                    Submit
                  </Button>
                </div>
                {showReasonError && (
                  <span id="aui-denial-reason-error" className="text-xs text-failure-bg" role="alert">
                    Reason is required
                  </span>
                )}
              </div>
            )}

            {isDecided && (
              <div className="flex items-start gap-2">
                <Icon
                  name={isDenied ? 'circle-xmark' : 'circle-check'}
                  size="0.875em"
                  className={cn('mt-0.5 shrink-0', isDenied ? 'text-failure-bg' : 'text-success-bg')}
                />
                <span className="font-sans text-[0.8125rem] font-medium text-text-primary">
                  {status.label ?? (isDenied ? 'This tool action was denied.' : 'This tool action was approved.')}
                  {status.reason ? (
                    <span className="font-normal text-text-secondary"> Reason: {status.reason}</span>
                  ) : null}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ToolApprovalBar: typeof ToolApprovalBar;
  }
}
