import { useAui } from '@assistant-ui/react';
import { useCallback } from 'react';

import { useOptionalComposerBusyState } from './useComposerBusyState.js';

/** Puts a prompt in the composer and sends it, through the same busy-state wrapper the send button uses. */
export function useSendPrompt(): (prompt: string) => void {
  const aui = useAui();
  const busy = useOptionalComposerBusyState();
  return useCallback(
    (prompt: string) => {
      aui.composer().setText(prompt);
      const send = () => aui.composer().send();
      if (busy === null) {
        send();
      } else {
        busy.send(send);
      }
    },
    [aui, busy],
  );
}
