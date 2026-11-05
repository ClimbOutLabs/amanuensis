import { EventType, type TurnHandle, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { RawToolCall } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import type { Logger } from 'winston';
import type { TurnCustom } from '../db/sessionCustom';

/** A tool call is named by the thread that made it and its id; ids alone are not unique across threads. */
export function toolCallKey({ threadId, callId }: { threadId: string; callId: string }): string {
  return `${threadId}\u0000${callId}`;
}

/** Newest events read from the paused turn, a page at a time. The model message behind a card is near the end. */
const EVENTS_PAGE_LIMIT = 100;
const EVENTS_MAX_PAGES = 3;

/**
 * The calls the person allowed on a card, as the paused turn's model asked for them. An approved call runs
 * in the turn that carries the approval, which never sees the message that asked for it, so the drain of
 * that turn needs the call from here to know what ran. Reads from the end of the paused turn and stops once
 * every allowed call is found. Empty when the input allows nothing; also empty, with a log line, when the
 * turn cannot be read, so a read failure never holds up the person's turn.
 */
export async function approvedToolCalls({
  pausedTurn,
  input,
  logger,
}: {
  pausedTurn: Pick<TurnHandle<TurnCustom>, 'listEvents'> | undefined;
  input: readonly TurnInputItem[] | undefined;
  logger: Logger;
}): Promise<Map<string, RawToolCall>> {
  const wanted = new Set(
    (input ?? []).flatMap(item =>
      item.type === EventType.USER_TOOL_APPROVAL && item.approval.status === 'allow'
        ? [toolCallKey({ threadId: item.thread_id, callId: item.tool_call_id })]
        : [],
    ),
  );
  const calls = new Map<string, RawToolCall>();
  if (pausedTurn === undefined || wanted.size === 0) {
    return calls;
  }
  try {
    let pageToken: string | undefined;
    for (let page = 0; page < EVENTS_MAX_PAGES && calls.size < wanted.size; page += 1) {
      const events = await pausedTurn.listEvents({ limit: EVENTS_PAGE_LIMIT, order: 'desc', page_token: pageToken });
      for (const event of events.data) {
        if (event.type !== EventType.MODEL_MESSAGE) {
          continue;
        }
        for (const call of event.tool_calls ?? []) {
          const key = toolCallKey({ threadId: event.thread_id, callId: call.id });
          if (wanted.has(key)) {
            calls.set(key, call);
          }
        }
      }
      pageToken = events.pagination.next_page_token;
      if (pageToken === undefined) {
        break;
      }
    }
  } catch (error) {
    logger.warn('Could not read the paused turn for approved calls; a sent message may not be saved to memory', {
      ...extractErrorLogFields(error),
    });
    return new Map();
  }
  return calls;
}
