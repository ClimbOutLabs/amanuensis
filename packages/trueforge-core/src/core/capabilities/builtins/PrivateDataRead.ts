import { hasReadPrivateData, markPrivateDataRead, type WebSearchTurnState } from '../../permissions/webSearch';
import { InternalEventType } from '../../runtime/AgentThread.types';
import type { AgentCapability } from '../AgentCapability';

export const PRIVATE_DATA_READ_STATE_KEY = 'tfy.private_data_read';

/**
 * Keeps "this chat read private data" for the life of the session. The turn's search state starts clean every
 * turn, so the flag is saved once it is set and put back at the start of the next turn.
 */
export function privateDataReadCapability(input: { turn: WebSearchTurnState }): AgentCapability {
  let saved = false;
  return {
    state: {
      key: PRIVATE_DATA_READ_STATE_KEY,
      load: state => {
        if (state === true) {
          saved = true;
          markPrivateDataRead(input.turn);
        }
      },
    },
    postToolCallProcessors: [
      {
        // eslint-disable-next-line @typescript-eslint/require-await -- async *: AsyncIterable contract; body is sync
        async *processPostToolCall() {
          if (saved || !hasReadPrivateData(input.turn)) {
            return;
          }
          saved = true;
          yield { type: InternalEventType.CAPABILITY_STATE, key: PRIVATE_DATA_READ_STATE_KEY, state: true };
        },
      },
    ],
  };
}
