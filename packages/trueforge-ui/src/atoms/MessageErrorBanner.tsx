import { cn } from './lib/cn.js';

export type MessageErrorBannerAction = {
  label: string;
  onClick: () => void;
};

export type MessageErrorBannerProps = {
  message: string;
  className?: string;
  /** Optional retry-style action rendered next to the message. */
  action?: MessageErrorBannerAction;
  /** Optional dismissal: renders a Dismiss button next to the action. */
  onDismiss?: () => void;
};

const CONTROL_BUTTON_CLASS =
  'aui-message-error-action shrink-0 rounded-md border border-current px-2 py-1 text-xs font-medium hover:opacity-80';

export function MessageErrorBanner({ message, className, action, onDismiss }: MessageErrorBannerProps) {
  const messageSpan = <span className="aui-message-error-message line-clamp-2">{message}</span>;
  return (
    <div
      role="alert"
      className={cn(
        'aui-message-error-root border-failure-bg bg-failure-bg/10 text-failure-bg mt-2 rounded-md border p-3 text-sm',
        className,
      )}
    >
      {action == null && onDismiss == null ? (
        messageSpan
      ) : (
        <div className="flex items-start justify-between gap-3">
          {messageSpan}
          <div className="flex shrink-0 gap-2">
            {onDismiss != null && (
              <button type="button" onClick={onDismiss} className={CONTROL_BUTTON_CLASS}>
                Dismiss
              </button>
            )}
            {action != null && (
              <button type="button" onClick={action.onClick} className={CONTROL_BUTTON_CLASS}>
                {action.label}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    MessageErrorBanner: typeof MessageErrorBanner;
  }
}
