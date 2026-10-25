import { forwardRef, type ComponentPropsWithRef, type CSSProperties } from 'react';

import { cn } from './lib/cn.js';

const THREAD_CSS_VARS: CSSProperties & { '--thread-max-width': string; '--composer-padding': string } = {
  // Readable column width for both the message list and the composer (both consume this
  // same variable in ThreadViewportShell and ThreadComposerAreaShell below, so they can
  // never drift apart). About 48rem with 1rem side margins; a folded side panel lends the
  // column some of its width through --thread-extra-left / --thread-extra-right.
  '--thread-max-width':
    'min(calc(48rem + var(--thread-extra-left, 0rem) + var(--thread-extra-right, 0rem)), 100% - 2rem)',
  '--composer-padding': '0.75rem',
};

export type ThreadRootShellProps = ComponentPropsWithRef<'div'>;

export const ThreadRootShell = forwardRef<HTMLDivElement, ThreadRootShellProps>(
  ({ className, style, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn(
        'font-sans-flex aui-root aui-thread-root bg-primary-bg @container flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden',
        className,
      )}
      style={{ ...THREAD_CSS_VARS, ...style }}
      {...rest}
    />
  ),
);
ThreadRootShell.displayName = 'ThreadRootShell';

export type ThreadViewportShellProps = ComponentPropsWithRef<'div'> & {
  isEmpty?: boolean;
};

export const ThreadViewportShell = forwardRef<HTMLDivElement, ThreadViewportShellProps>(
  ({ className, isEmpty, children, ...rest }, ref) => (
    <div
      ref={ref}
      data-slot="aui_thread-viewport"
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain',
        className,
      )}
      {...rest}
    >
      <div
        className={cn(
          'mx-auto flex w-full min-w-0 max-w-(--thread-max-width) flex-col px-3 pt-3 motion-safe:transition-[max-width] motion-safe:duration-300 motion-safe:ease-out',
          // Safe centring keeps a first frame taller than the screen scrollable from its top.
          isEmpty ? 'min-h-full justify-[safe_center] pb-4' : 'pb-24',
        )}
      >
        {children}
      </div>
    </div>
  ),
);
ThreadViewportShell.displayName = 'ThreadViewportShell';

export type ThreadComposerAreaShellProps = ComponentPropsWithRef<'div'> & {
  isEmpty?: boolean;
};

export const ThreadComposerAreaShell = forwardRef<HTMLDivElement, ThreadComposerAreaShellProps>(
  ({ className, isEmpty, ...rest }, ref) => (
    <div
      ref={ref}
      data-slot="aui_thread-composer"
      className={cn(
        // Desktop: square top edge, and nothing overlays the messages above the composer. A
        // gradient fade there washed over the bottom of a waiting approval card while it was
        // scrolled into view, so its buttons looked faded, as if the card were disabled.
        'aui-thread-composer bg-primary-bg mx-auto flex w-full min-w-0 max-w-(--thread-max-width) motion-safe:transition-[max-width] motion-safe:duration-300 motion-safe:ease-out shrink-0 flex-col gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom,0px))] sm:gap-4 sm:px-4 md:pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]',
        !isEmpty && 'rounded-t-(--composer-radius) md:rounded-t-none',
        className,
      )}
      {...rest}
    />
  ),
);
ThreadComposerAreaShell.displayName = 'ThreadComposerAreaShell';

export type MessageGroupProps = ComponentPropsWithRef<'div'>;

export const MessageGroup = forwardRef<HTMLDivElement, MessageGroupProps>(({ className, ...rest }, ref) => (
  <div
    ref={ref}
    data-slot="aui_message-group"
    className={cn('flex flex-col gap-y-4 empty:hidden', className)}
    {...rest}
  />
));
MessageGroup.displayName = 'MessageGroup';

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ThreadRootShell: typeof ThreadRootShell;
    ThreadViewportShell: typeof ThreadViewportShell;
    ThreadComposerAreaShell: typeof ThreadComposerAreaShell;
    MessageGroup: typeof MessageGroup;
  }
}
