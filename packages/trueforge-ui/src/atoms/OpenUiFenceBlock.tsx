'use client';

import { Renderer } from '@openuidev/react-lang';
import { ThemeProvider } from '@openuidev/react-ui';
import { useMemo } from 'react';

import { useOptionalContentClassNames } from '../theme/ThemeProvider.js';
import { ExternalUrlConfirmProvider } from './externalUrlConfirm.js';
import { cn } from './lib/cn.js';
import { createGatedOpenUiLibrary } from './lib/gatedOpenUiLibrary.js';
import { repairOpenUiSource } from './lib/repairOpenUiSource.js';

export type OpenUiFenceBlockProps = {
  content: string;
  isStreaming?: boolean;
  darkTheme?: boolean;
  /** Mirrors the Markdown prop of the same name, so a fence on a space page gates its pictures the same way. */
  spacePictures?: boolean;
};

export function OpenUiFenceBlock({ content, isStreaming, darkTheme, spacePictures }: OpenUiFenceBlockProps) {
  const classNames = useOptionalContentClassNames();
  const response = useMemo(() => repairOpenUiSource(content), [content]);
  // The fence renders with Aman's gated copy of the OpenUI library: its image and
  // markdown components go through the same image and link gates as chat markdown.
  const library = useMemo(() => createGatedOpenUiLibrary({ spacePictures: spacePictures === true }), [spacePictures]);

  return (
    <div className={cn('aui-openui mb-2 w-full min-w-0 max-w-full', classNames.openui?.root)}>
      <ExternalUrlConfirmProvider>
        <ThemeProvider mode={darkTheme ? 'dark' : 'light'} cssSelector=".markdown-openui-scope">
          <div
            className={cn('markdown-openui-scope min-w-0 w-full max-w-full overflow-x-auto', classNames.openui?.scope)}
          >
            <Renderer response={response} library={library} isStreaming={isStreaming} />
          </div>
        </ThemeProvider>
      </ExternalUrlConfirmProvider>
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    OpenUiFenceBlock: typeof OpenUiFenceBlock;
  }
}
