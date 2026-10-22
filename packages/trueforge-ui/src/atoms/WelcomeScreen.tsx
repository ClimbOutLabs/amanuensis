import type { ReactNode } from 'react';

import { useOptionalThemePreset } from '../theme/ThemeProvider.js';
import { cn } from './lib/cn.js';

export type WelcomeScreenProps = {
  heading?: ReactNode;
  icon?: ReactNode;
  className?: string;
};

export function WelcomeScreen({ heading = 'How can I help you today?', icon = null, className }: WelcomeScreenProps) {
  const preset = useOptionalThemePreset();

  return (
    <div
      data-preset={preset}
      className={cn(
        'aui-thread-welcome-root relative isolate mb-6 flex flex-col items-center px-4 text-center text-text-primary',
        className,
      )}
    >
      {icon !== null && (
        <div className="fill-mode-both mb-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-reduce:animate-none duration-200">
          {icon}
        </div>
      )}
      <h1
        className={cn(
          'aui-thread-welcome-message-inner fill-mode-both text-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-reduce:animate-none',
          preset === 'paper' ? 'font-semibold' : 'font-normal',
          icon !== null && 'delay-75',
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
