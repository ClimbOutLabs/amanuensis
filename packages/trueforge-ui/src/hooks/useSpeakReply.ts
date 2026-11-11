import { useCallback } from 'react';

import { useOptionalPersonas } from '../components/PersonaContext.js';
import { useSpokenReply } from '../components/SpokenReplyContext.js';
import type { ServerVoiceId } from '../utils/speechReplyPreferences.js';
import type { SpokenReplyVoice } from '../utils/spokenReplyPlayer.js';

export type SpeakReplyInput = {
  text: string;
  /** What is being read, such as the message id. */
  key: string;
  sessionId: string | undefined;
  turnId: string | undefined;
  /** Checked after the voice is found; false means the reading is no longer wanted. */
  stillWanted?: () => boolean;
};

/**
 * Reads one reply aloud in the voice picked for the persona that wrote it, or in the person's own voice
 * choice when it has none. The lookup only happens when it could change the voice: with the computer's
 * voice wired and at least one persona that has a voice of its own. Otherwise reading starts at once, so
 * a tap still counts as the tap that lets the browser speak.
 */
export function useSpeakReply(): (input: SpeakReplyInput) => Promise<SpokenReplyVoice> {
  const spokenReply = useSpokenReply();
  const personas = useOptionalPersonas();
  const voiceForTurn = personas?.voiceForTurn;
  const anyPersonaVoice = personas?.personas.some(persona => persona.voice !== null) ?? false;

  return useCallback(
    async ({ text, key, sessionId, turnId, stillWanted }) => {
      const canChange =
        spokenReply.hasServerVoice() &&
        anyPersonaVoice &&
        voiceForTurn !== undefined &&
        sessionId !== undefined &&
        turnId !== undefined;
      if (!canChange) return spokenReply.speak(text, { key });
      let voice: ServerVoiceId | undefined;
      try {
        voice = await voiceForTurn({ sessionId, turnId });
      } catch {
        // Reading the reply in the person's own voice beats not reading it at all.
        voice = undefined;
      }
      if (stillWanted !== undefined && !stillWanted()) return 'none';
      return spokenReply.speak(text, { key, voice });
    },
    [spokenReply, anyPersonaVoice, voiceForTurn],
  );
}
