import type { PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type { RawToolCall } from '@truefoundry/trueforge-core/core/llm/LLMTypes';

/** The slice of a turn this reads: its saved events, a page at a time. */
interface PausedTurn {
  listEvents(input: {
    limit: number;
    order: 'asc';
    page_token: string | undefined;
  }): Promise<{ data: readonly PersistedTurnEvent[]; pagination: { next_page_token?: string | undefined } }>;
}

const EVENTS_PAGE_LIMIT = 100;

/**
 * The calls the person allowed on a card, as the paused turn's model asked for them. An approved call runs
 * in the turn that carries the approval, which never sees the message that asked for it, so the drain of
 * that turn needs the call from here to know what ran. Empty when the input allows nothing or the turn is gone.
 */
export async function approvedToolCalls({
  pausedTurn,
  input,
}: {
  pausedTurn: PausedTurn | undefined;
  input: readonly TurnInputItem[] | undefined;
}): Promise<Map<string, RawToolCall>> {
  const allowed = new Set(
    (input ?? []).flatMap(item =>
      item.type === EventType.USER_TOOL_APPROVAL && item.approval.status === 'allow' ? [item.tool_call_id] : [],
    ),
  );
  const calls = new Map<string, RawToolCall>();
  if (pausedTurn === undefined || allowed.size === 0) {
    return calls;
  }
  let pageToken: string | undefined;
  do {
    const page = await pausedTurn.listEvents({ limit: EVENTS_PAGE_LIMIT, order: 'asc', page_token: pageToken });
    for (const event of page.data) {
      if (event.type !== EventType.MODEL_MESSAGE) {
        continue;
      }
      for (const call of event.tool_calls ?? []) {
        if (allowed.has(call.id)) {
          calls.set(call.id, call);
        }
      }
    }
    pageToken = page.pagination.next_page_token;
  } while (pageToken !== undefined);
  return calls;
}
