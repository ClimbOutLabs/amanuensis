'use client';

import { Icon } from '../icons/Icon.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { useVoiceSettings } from '../voice/VoiceSettingsContext.js';
import { useVoiceSpeech } from '../voice/VoiceSpeechContext.js';
import { cn } from './lib/cn.js';
import { IconButton } from './primitives/IconButton.js';

export type MessageActionBarProps = {
  isCopied: boolean;
  onCopy: () => void;
  createdAt?: Date | string;
  className?: string;
  /** Message id, used for the speaking highlight. Enables read-aloud when set. */
  messageId?: string;
  /** Plain-text message content for read-aloud. Enables the button when non-empty. */
  speakText?: string;
};

const actionBtnClass = 'h-6 w-6 text-text-secondary hover:text-text-primary [&_svg]:size-3.5';

export function MessageActionBar({
  isCopied,
  onCopy,
  createdAt,
  className,
  messageId,
  speakText,
}: MessageActionBarProps) {
  const MessageTimestamp = useSlot('MessageTimestamp');
  const { settings } = useVoiceSettings();
  const speech = useVoiceSpeech();
  // The message id and text arrive as props from the message container, so
  // this atom never reaches into assistant-ui message state itself.
  const canSpeak =
    messageId !== undefined &&
    speakText !== undefined &&
    speakText.length > 0 &&
    speech.supported &&
    settings.ttsEnabled;
  const speaking = messageId !== undefined && speech.isSpeaking(messageId);

  return (
    <div
      className={cn('aui-assistant-action-bar-root animate-in fade-in flex items-center gap-1 duration-200', className)}
    >
      <MessageTimestamp createdAt={createdAt} className="mr-1" />
      <IconButton aria-label="Copy" tooltip="Copy" variant="ghost" className={actionBtnClass} onClick={onCopy}>
        <Icon name={isCopied ? 'check' : 'clone'} size="0.875em" />
      </IconButton>
      {canSpeak ? (
        <IconButton
          aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'}
          tooltip={speaking ? 'Stop reading aloud' : 'Read aloud'}
          aria-pressed={speaking}
          variant="ghost"
          className={cn(actionBtnClass, speaking && 'text-primary-button-bg')}
          onClick={() => {
            if (speaking) speech.stop();
            else if (messageId !== undefined && speakText !== undefined)
              speech.speak({ id: messageId, text: speakText });
          }}
        >
          <Icon name={speaking ? 'square' : 'volume-2'} size="0.875em" />
        </IconButton>
      ) : null}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    MessageActionBar: typeof MessageActionBar;
  }
}
