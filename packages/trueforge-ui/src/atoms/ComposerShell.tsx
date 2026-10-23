'use client';

import { type ReactNode } from 'react';

import { useSlot } from '../theme/SlotsProvider.js';
import { cn } from './lib/cn.js';

export type ComposerShellProps = {
  /** Message input node, supplied by the container (e.g. `<ComposerPrimitive.Input />`). */
  input: ReactNode;
  disabled: boolean;
  canSubmit: boolean;
  isRunning?: boolean;
  /** Stop was pressed and the turn has not stopped yet. */
  isStopping?: boolean;
  attachments?: ReactNode;
  modelLabel?: string;
  modelIcon?: ReactNode;
  connectorStatusLabel?: string;
  onSubmit: () => void;
  onCancel?: () => void;
  onAttach?: () => void;
  className?: string;
};

/** The one owner of the words for a reply in progress, shown in the composer and the panel. */
export const WORKING_ON_IT_LABEL = 'Working on it';

/**
 * The composer card. It holds the attachment chips above the input and one toolbar row below it:
 * the `+` menu, a gold status while a turn runs, then the model, the mic and Send or Stop.
 */
export function ComposerShell({
  input,
  disabled,
  canSubmit,
  isRunning = false,
  isStopping = false,
  attachments,
  modelLabel,
  modelIcon,
  connectorStatusLabel,
  onSubmit,
  onCancel,
  onAttach,
  className,
}: ComposerShellProps) {
  const ComposerLeftSection = useSlot('ComposerLeftSection');
  const ComposerRightSection = useSlot('ComposerRightSection');
  const ComposerSendButton = useSlot('ComposerSendButton');

  return (
    <div
      data-slot="aui_composer-shell"
      className={cn(
        'border-border bg-card-bg focus-within:border-gold-line flex w-full flex-col gap-2 rounded-[1.25rem] border px-3.5 pt-3.5 pb-2.5 transition-colors',
        className,
      )}
    >
      {attachments}
      {input}
      <div className="aui-composer-footer flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="aui-composer-leading flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <ComposerLeftSection disabled={disabled} isRunning={isRunning} onAttach={onAttach} />
          {isRunning ? (
            <span role="status" className="text-text-secondary flex items-center gap-2 text-[0.8125rem]">
              <span className="bg-gold size-2 shrink-0 rounded-full" aria-hidden />
              {WORKING_ON_IT_LABEL}
            </span>
          ) : null}
          {connectorStatusLabel && (
            <span className="text-text-secondary max-w-[12rem] truncate text-[0.8125rem]">{connectorStatusLabel}</span>
          )}
        </div>
        <div className="aui-composer-actions ml-auto flex min-w-0 max-w-full shrink-0 flex-wrap items-center justify-end gap-1">
          {modelLabel && !isRunning && (
            <span className="text-text-secondary flex max-w-[10rem] items-center gap-1 truncate px-2 text-[0.8125rem]">
              {modelIcon}
              <span className="truncate">{modelLabel}</span>
            </span>
          )}
          <ComposerRightSection disabled={disabled} isRunning={isRunning} />
          <ComposerSendButton
            disabled={disabled}
            canSubmit={canSubmit}
            isRunning={isRunning}
            isStopping={isStopping}
            onSubmit={onSubmit}
            onCancel={onCancel}
          />
        </div>
      </div>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ComposerShell: typeof ComposerShell;
  }
}
