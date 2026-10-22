'use client';

import { Icon } from '../icons/Icon.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { cn } from './lib/cn.js';
import { IconButton } from './primitives/IconButton.js';

/** Read-aloud controls for a finished answer. Omitted when this browser cannot read text aloud. */
export type MessageSpeechControls = {
  speaking: boolean;
  onSpeak: () => void;
  onStop: () => void;
};

export type MessageActionBarProps = {
  isCopied: boolean;
  onCopy: () => void;
  createdAt?: Date | string;
  speech?: MessageSpeechControls;
  className?: string;
};

const actionBtnClass = 'h-6 w-6 text-text-secondary hover:text-text-primary [&_svg]:size-3.5';

export function MessageActionBar({ isCopied, onCopy, createdAt, speech, className }: MessageActionBarProps) {
  const MessageTimestamp = useSlot('MessageTimestamp');

  return (
    <div
      className={cn(
        'aui-assistant-action-bar-root animate-in fade-in flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100 focus-within:opacity-100',
        className,
      )}
    >
      <MessageTimestamp createdAt={createdAt} className="mr-1" />
      <IconButton aria-label="Copy" tooltip="Copy" variant="ghost" className={actionBtnClass} onClick={onCopy}>
        <Icon name={isCopied ? 'check' : 'clone'} size="0.875em" />
      </IconButton>
      {speech !== undefined &&
        (speech.speaking ? (
          <IconButton
            aria-label="Stop reading aloud"
            tooltip="Stop reading aloud"
            variant="ghost"
            className={actionBtnClass}
            onClick={speech.onStop}
          >
            <Icon name="stop" size="0.875em" />
          </IconButton>
        ) : (
          <IconButton
            aria-label="Read answer aloud"
            tooltip="Read aloud"
            variant="ghost"
            className={actionBtnClass}
            onClick={speech.onSpeak}
          >
            <Icon name="volume-high" size="0.875em" />
          </IconButton>
        ))}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    MessageActionBar: typeof MessageActionBar;
  }
}
