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
};

export function MessageErrorBanner({ message, className, action }: MessageErrorBannerProps) {
  const messageSpan = <span className="aui-message-error-message line-clamp-2">{message}</span>;
  return (
    <div
      role="alert"
      className={cn(
        'aui-message-error-root border-failure-bg bg-failure-bg/10 text-failure-bg mt-2 rounded-md border p-3 text-sm',
        className,
      )}
    >
      {action == null ? (
        messageSpan
      ) : (
        <div className="flex items-start justify-between gap-3">
          {messageSpan}
          <button
            type="button"
            onClick={action.onClick}
            className="aui-message-error-action shrink-0 rounded-md border border-current px-2 py-1 text-xs font-medium hover:opacity-80"
          >
            {action.label}
          </button>
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
