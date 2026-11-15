'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef } from 'react';

import { chatChanged, endLiveLine, mountLiveLineBridge, setLiveNotice } from '../utils/voiceMode.js';

const VOICE_MODE_ENDED_MESSAGE = 'Voice mode ended because the connection closed. Tap it to start again.';
const VOICE_MODE_MIC_LOST_MESSAGE =
  'Voice mode ended because the microphone stopped. Check it, then tap to start again.';

/**
 * Holds the live voice line for the chat on screen. It sits above the part of the chat that is replaced
 * while the chat loads, so the composer coming and going (a reload after a spoken turn, an approval card)
 * never ends the line. The line ends only on another chat, leaving the page, a hidden tab or a tap.
 */
export function LiveVoiceBridge() {
  const reload = useTrueFoundryReload();
  const sessionId = useAuiState(s => s.threadListItem.remoteId);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(
    () =>
      mountLiveLineBridge({
        onTurnSaved: () => reloadRef.current(),
        onEnded: reason => {
          setLiveNotice(reason === 'mic_lost' ? VOICE_MODE_MIC_LOST_MESSAGE : VOICE_MODE_ENDED_MESSAGE);
        },
      }),
    [],
  );

  useEffect(() => {
    chatChanged(sessionId ?? null);
  }, [sessionId]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') endLiveLine();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return null;
}
