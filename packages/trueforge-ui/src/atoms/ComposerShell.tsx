'use client';

import { type ReactNode } from 'react';

import { useSlot } from '../theme/SlotsProvider.js';
import type { DraftComposerAction } from './draft/DraftComposerActionsMenu.js';
import { cn } from './lib/cn.js';

export type ComposerShellProps = {
  /** Message input node, supplied by the container (e.g. `<ComposerPrimitive.Input />`). */
  input: ReactNode;
  disabled: boolean;
  canSubmit: boolean;
  isRunning?: boolean;
  /** Cancel was pressed and the turn has not stopped yet. */
  isStopping?: boolean;
  attachments?: ReactNode;
  /** Work on a repo menu item for the "+" menu; omitted when unavailable. */
  workOnRepo?: DraftComposerAction | null;
  onSubmit: () => void;
  onCancel?: () => void;
  onAttach?: () => void;
  className?: string;
};

/** One rounded box: the text area on top, one toolbar row underneath. */
export function ComposerShell({
  input,
  disabled,
  canSubmit,
  isRunning = false,
  isStopping = false,
  attachments,
  workOnRepo,
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
        'focus-within:ring-focus-ring/20 bg-card-bg border-border flex w-full flex-col gap-2 rounded-[1.25rem] border p-3 shadow-[0_0.25rem_1.25rem_-0.5rem_color-mix(in_oklab,var(--shadow-color)_18%,transparent)] transition-colors focus-within:ring-3',
        className,
      )}
    >
      {attachments}
      {input}
      <div className="aui-composer-footer flex min-w-0 items-center justify-between gap-2">
        <div className="aui-composer-leading flex shrink-0 items-center gap-1">
          <ComposerLeftSection disabled={disabled} isRunning={isRunning} onAttach={onAttach} workOnRepo={workOnRepo} />
        </div>
        <div className="aui-composer-actions flex min-w-0 shrink items-center justify-end gap-1">
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
