'use client';

import type { ReactNode } from 'react';

import { Spinner } from '../atoms/primitives/Spinner.js';
import { Icon } from '../icons/Icon.js';
import { DraftComposerActionsMenu, type DraftComposerAction } from './draft/DraftComposerActionsMenu.js';
import { cn } from './lib/cn.js';
import { VoiceInputButton } from './VoiceInputButton.js';

export type ComposerLeftSectionProps = {
  disabled: boolean;
  isRunning: boolean;
  onAttach?: () => void;
  /** Work on a repo menu item; omitted when the feature is unavailable here. */
  workOnRepo?: DraftComposerAction | null;
};

export type ComposerRightSectionProps = {
  disabled: boolean;
  isRunning: boolean;
};

export type ComposerSendButtonProps = {
  disabled: boolean;
  canSubmit: boolean;
  isRunning: boolean;
  /** Cancel was pressed and the turn has not stopped yet. */
  isStopping?: boolean;
  onSubmit: () => void;
  onCancel?: () => void;
};

export type ComposerLeftSectionSlot = (props: ComposerLeftSectionProps) => ReactNode;
export type ComposerRightSectionSlot = (props: ComposerRightSectionProps) => ReactNode;
export type ComposerSendButtonSlot = (props: ComposerSendButtonProps) => ReactNode;

/** The round "+" menu: attach, then add-ons where a model is picked, then work on a repo. */
export function ComposerLeftSection({ disabled, onAttach, workOnRepo = null }: ComposerLeftSectionProps) {
  const actions: DraftComposerAction[] = [
    ...(onAttach === undefined
      ? []
      : [{ id: 'attach', label: 'Attach a file', icon: 'paperclip', onSelect: onAttach }]),
    ...(workOnRepo ? [workOnRepo] : []),
  ];

  return <DraftComposerActionsMenu actions={actions} disabled={disabled} />;
}

export function ComposerRightSection({ disabled }: ComposerRightSectionProps): ReactNode {
  return <VoiceInputButton disabled={disabled} />;
}

const roundButtonBase =
  'inline-flex size-11 shrink-0 cursor-pointer sm:size-8 items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:outline-none disabled:cursor-not-allowed';

export function ComposerSendButton({
  canSubmit,
  isRunning,
  isStopping = false,
  onSubmit,
  onCancel,
}: ComposerSendButtonProps) {
  if (isRunning) {
    const stopLabel = isStopping ? 'Stopping' : 'Stop';
    return (
      <button
        type="button"
        data-slot="aui_composer-cancel"
        data-state="stop"
        className={cn(
          roundButtonBase,
          'aui-composer-cancel-button bg-primary-button-bg text-primary-button-text hover:bg-primary-button-hover disabled:opacity-60',
        )}
        disabled={!onCancel || isStopping}
        onClick={onCancel}
        aria-label={stopLabel}
        title={stopLabel}
      >
        {isStopping ? (
          <Spinner size={14} />
        ) : (
          <span aria-hidden="true" className="block size-3 rounded-sm bg-current" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-slot="aui_composer-send"
      data-state={canSubmit ? 'ready' : 'muted'}
      className={cn(
        roundButtonBase,
        'aui-composer-send-button',
        canSubmit
          ? 'bg-primary-button-bg text-primary-button-text hover:bg-primary-button-hover'
          : 'bg-secondary-bg text-text-secondary',
      )}
      disabled={!canSubmit}
      onClick={onSubmit}
      title="Send message"
      aria-label="Send message"
    >
      <Icon name="arrow-up" className="size-4" />
    </button>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ComposerLeftSection: ComposerLeftSectionSlot;
    ComposerRightSection: ComposerRightSectionSlot;
    ComposerSendButton: ComposerSendButtonSlot;
  }
}
