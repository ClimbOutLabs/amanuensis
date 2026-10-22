/**
 * Server-side approval gate for eval instances. The runner answers every approval card with its prompt's
 * policy, so the server alone decides what an eval may run: only the fixture-backed mail and calendar tools,
 * maps, and web search. Any other approval is turned into a denial before the turn runs.
 */
import { z } from 'zod';

import { EventType, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import {
  CREATE_EVENT_TOOL_NAME,
  GET_EVENT_TOOL_NAME,
  LIST_EVENTS_TOOL_NAME,
  UPDATE_EVENT_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/calendar/toolContract';
import {
  DOWNLOAD_ATTACHMENT_TOOL_NAME,
  DRAFT_EMAIL_TOOL_NAME,
  GET_DRAFT_TOOL_NAME,
  GET_THREAD_TOOL_NAME,
  LIST_DRAFTS_TOOL_NAME,
  LIST_INBOX_THREADS_TOOL_NAME,
  READ_EMAIL_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/email/gmail/toolContract';
import { MAPS_TOOL_NAMES } from '@truefoundry/trueforge-core/core/permissions/mapsToolNames';
import { TAVILY_SEARCH_TOOL_NAME } from '@truefoundry/trueforge-core/core/search/TavilyClient';

/** Sending mail is deliberately absent: an eval run may draft, never send. */
const EVAL_APPROVABLE_TOOL_NAMES: readonly string[] = [
  LIST_INBOX_THREADS_TOOL_NAME,
  GET_THREAD_TOOL_NAME,
  READ_EMAIL_TOOL_NAME,
  DOWNLOAD_ATTACHMENT_TOOL_NAME,
  LIST_DRAFTS_TOOL_NAME,
  GET_DRAFT_TOOL_NAME,
  DRAFT_EMAIL_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
  LIST_EVENTS_TOOL_NAME,
  GET_EVENT_TOOL_NAME,
  CREATE_EVENT_TOOL_NAME,
  UPDATE_EVENT_TOOL_NAME,
  ...MAPS_TOOL_NAMES,
  TAVILY_SEARCH_TOOL_NAME,
];

export const EVAL_DECLINE_REASON =
  'Declined: an eval instance approves only its own mail, calendar, map and search tools.';

const ModelMessageSchema = z.object({
  type: z.literal(EventType.MODEL_MESSAGE),
  tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string() }) })).optional(),
});

/** The slice of a session the gate reads: the paused turn's events, one page at a time. */
export interface EvalApprovalSession {
  getTurn(turn_id: string): Promise<EvalApprovalTurn | undefined>;
}

export interface EvalApprovalTurn {
  listEvents(input: {
    limit: number;
    order: 'asc';
    page_token: string | undefined;
  }): Promise<{ data: readonly unknown[]; pagination: { next_page_token?: string | undefined } }>;
}

/**
 * Reads the names of the tool calls the paused turn asked for. Approval cards carry only call ids, so the
 * name comes from the assistant message that requested the call. Calls with no matching message stay unnamed
 * and are declined.
 */
async function toolNamesByCallId(turn: EvalApprovalTurn | undefined): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (turn === undefined) {
    return names;
  }
  let pageToken: string | undefined;
  do {
    const page = await turn.listEvents({ limit: 100, order: 'asc', page_token: pageToken });
    for (const event of page.data) {
      const message = ModelMessageSchema.safeParse(event);
      for (const call of message.success ? (message.data.tool_calls ?? []) : []) {
        names.set(call.id, call.function.name);
      }
    }
    pageToken = page.pagination.next_page_token;
  } while (pageToken !== undefined);
  return names;
}

/**
 * Turns every approval that asks for a tool outside the eval allowlist into a denial. Other items pass through
 * unchanged. If the paused turn cannot be read, every allowed approval is denied.
 */
export async function gateEvalApprovals({
  session,
  previous_turn_id,
  input,
}: {
  session: EvalApprovalSession;
  previous_turn_id: string;
  input: TurnInputItem[] | undefined;
}): Promise<TurnInputItem[] | undefined> {
  if (!input?.some(item => item.type === EventType.USER_TOOL_APPROVAL && item.approval.status === 'allow')) {
    return input;
  }
  const names = await toolNamesByCallId(await session.getTurn(previous_turn_id));
  return input.map(item => {
    if (item.type !== EventType.USER_TOOL_APPROVAL || item.approval.status !== 'allow') {
      return item;
    }
    const name = names.get(item.tool_call_id);
    if (name !== undefined && EVAL_APPROVABLE_TOOL_NAMES.includes(name)) {
      return item;
    }
    return { ...item, approval: { status: 'deny', reason: EVAL_DECLINE_REASON } };
  });
}
