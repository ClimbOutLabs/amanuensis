'use client';

import type { ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { cn } from './lib/cn.js';
import { VoiceInputButton } from './VoiceInputButton.js';

export type ComposerLeftSectionProps = {
  disabled: boolean;
  isRunning: boolean;
  onAttach?: () => void;
};

export type ComposerRightSectionProps = {
  disabled: boolean;
  isRunning: boolean;
};

export type ComposerSendButtonProps = {
  disabled: boolean;
  canSubmit: boolean;
  isRunning: boolean;
  /** Stop was pressed and the turn has not stopped yet. */
  isStopping?: boolean;
  onSubmit: () => void;
  onCancel?: () => void;
};

export type ComposerLeftSectionSlot = (props: ComposerLeftSectionProps) => ReactNode;
export type ComposerRightSectionSlot = (props: ComposerRightSectionProps) => ReactNode;
export type ComposerSendButtonSlot = (props: ComposerSendButtonProps) => ReactNode;

/** The round `+` that opens the composer's menu; the plain composer offers only attaching. */
export function ComposerLeftSection({ disabled, isRunning, onAttach }: ComposerLeftSectionProps) {
  const DraftComposerActionsMenu = useSlot('DraftComposerActionsMenu');
  const actions =
    onAttach === undefined ? [] : [{ id: 'attach', label: 'Attach files', icon: 'paperclip', onSelect: onAttach }];

  return <DraftComposerActionsMenu actions={actions} disabled={disabled || isRunning} />;
}

/** Hidden while a turn runs, so Stop is the only control at the end of the bar. */
export function ComposerRightSection({ disabled, isRunning }: ComposerRightSectionProps): ReactNode {
  if (isRunning) return null;
  return <VoiceInputButton disabled={disabled} />;
}

/**
 * Outlined while there is nothing to send; filled in the gold ink once there is text. While a turn
 * runs it becomes the Stop button. The dark theme fills with gold and uses the dark paper for the arrow.
 */
export function ComposerSendButton({
  canSubmit,
  isRunning,
  isStopping = false,
  onSubmit,
  onCancel,
}: ComposerSendButtonProps) {
  if (isRunning) {
    return (
      <button
        type="button"
        data-slot="aui_composer-stop"
        className="border-gold-ink text-gold-ink hover:bg-gold-soft focus-visible:ring-focus-ring/40 flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        disabled={!onCancel || isStopping}
        onClick={onCancel}
        title="Stop (Esc)"
        aria-label={isStopping ? 'Stopping' : 'Stop'}
      >
        <Icon name="square" className="size-3.5 fill-current" />
      </button>
    );
  }

  return (
    <button
      type="button"
      data-slot="aui_composer-send"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
        canSubmit
          ? 'border-gold-ink bg-gold-ink text-card-bg dark:border-gold dark:bg-gold dark:text-paper'
          : 'border-border text-text-secondary',
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
