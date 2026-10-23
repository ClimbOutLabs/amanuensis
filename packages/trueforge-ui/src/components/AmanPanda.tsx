'use client';

import { createContext, useContext, type FC, type ReactNode } from 'react';

import { cn } from '../atoms/lib/cn.js';

import { AVATAR_ALT } from './AmanAvatarMotion.js';

const AmanPandaSourceContext = createContext<string | null>(null);

/**
 * The host passes the panda picture's URL once, so surfaces that sit inside the welcome screen can
 * show the same picture as the rail without the package knowing where the host serves it.
 */
export const AmanPandaSourceProvider: FC<{ src: string; children: ReactNode }> = ({ src, children }) => (
  <AmanPandaSourceContext.Provider value={src}>{children}</AmanPandaSourceContext.Provider>
);

export function useOptionalAmanPandaSrc(): string | null {
  return useContext(AmanPandaSourceContext);
}

/**
 * The small round panda ticket the phone's first frame shows under the day ticket. Renders nothing
 * when the host gave no picture, so the frame stays whole without it.
 */
export const AmanPandaRoundTicket: FC<{ src: string | null; name: string; className?: string }> = ({
  src,
  name,
  className,
}) => {
  if (src === null) {
    return null;
  }
  return (
    <div className={cn('aui-ticket aui-ticket--punch flex items-center gap-3 p-3', className)}>
      <img
        src={src}
        alt={AVATAR_ALT}
        className="size-[3.4rem] shrink-0 rounded-full border-[0.125rem] border-gold object-cover"
      />
      <div className="min-w-0">
        <p className="aui-section-heading">{name}</p>
      </div>
    </div>
  );
};
