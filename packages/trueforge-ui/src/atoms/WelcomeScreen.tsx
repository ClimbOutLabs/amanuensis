import type { ReactNode } from 'react';

import { useSlot } from '../theme/SlotsProvider.js';
import { useOptionalThemePreset } from '../theme/ThemeProvider.js';
import { cn } from './lib/cn.js';

export type WelcomeScreenProps = {
  heading?: string;
  icon?: ReactNode;
  className?: string;
};

export function WelcomeScreen({ heading = 'How can I help you today?', icon, className }: WelcomeScreenProps) {
  const preset = useOptionalThemePreset();
  const BrandLogo = useSlot('BrandLogo');
  const resolvedIcon =
    icon !== undefined ? icon : preset === 'high-contrast' ? null : <BrandLogo variant="icon" className="size-10" />;

  return (
    <div
      data-preset={preset}
      className={cn(
        'aui-thread-welcome-root relative isolate mb-6 flex flex-col items-center px-4 text-center text-text-primary',
        className,
      )}
    >
      {resolvedIcon !== null && (
        <div
          className={cn(
            'fill-mode-both mb-4 duration-200 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-reduce:animate-none',
          )}
        >
          {resolvedIcon}
        </div>
      )}
      <h1
        className={cn(
          'aui-thread-welcome-message-inner fill-mode-both text-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-reduce:animate-none',
          preset === 'paper' ? 'font-semibold' : 'font-normal',
          resolvedIcon !== null && 'delay-75',
          'duration-200',
        )}
      >
        {heading}
      </h1>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    WelcomeScreen: typeof WelcomeScreen;
  }
}
