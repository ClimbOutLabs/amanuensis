'use client';

import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';

import { createSpokenReplyPlayer, type ServerVoiceApi, type SpokenReplyPlayer } from '../utils/spokenReplyPlayer.js';

const SpokenReplyContext = createContext<SpokenReplyPlayer | null>(null);

/** Wires the host's server voice; spoken replies prefer it and fall back to the browser voice. */
export const SpokenReplyProvider: FC<{ serverVoice: ServerVoiceApi; children: ReactNode }> = ({
  serverVoice,
  children,
}) => {
  const player = useMemo(() => createSpokenReplyPlayer({ serverVoice }), [serverVoice]);
  return <SpokenReplyContext.Provider value={player}>{children}</SpokenReplyContext.Provider>;
};

const browserOnlyPlayer: { current: SpokenReplyPlayer | null } = { current: null };

/** The player for spoken replies. Without a provider it reads with the browser voice only. */
export function useSpokenReply(): SpokenReplyPlayer {
  const player = useContext(SpokenReplyContext);
  if (player !== null) {
    return player;
  }
  browserOnlyPlayer.current ??= createSpokenReplyPlayer({ serverVoice: null });
  return browserOnlyPlayer.current;
}
