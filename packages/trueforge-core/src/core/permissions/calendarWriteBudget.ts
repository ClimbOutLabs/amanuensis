import type { ApprovalDecision } from '../events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../llm/LLMTypes';
import { stableStringify } from './approvalTokens';
import { isCalendarChangeToolName } from './extractorRegistry';

/** Most calendar changes one turn may make, approved or not; the rest are refused without a card. */
export const MAX_CALENDAR_WRITES_PER_TURN = 5;

const CALENDAR_WRITE_REASONS: ReadonlySet<string> = new Set([
  'calendar_write',
  'caldav_calendar_change',
  'caldav_invitation_reply',
  'connector_calendar_write',
]);

const REPEATED_WRITE_MESSAGE =
  'This exact calendar change was already made in this turn, so it was not made again. Do not repeat it.';
const REPEATED_WRITE_OWNER_MESSAGE = 'Aman tried to make the same calendar change twice. It was made only once.';
const TOO_MANY_WRITES_MESSAGE = `Only ${String(MAX_CALENDAR_WRITES_PER_TURN)} calendar changes are allowed in one turn, so this one was not made. Stop changing the calendar and tell the person which changes are left.`;
const TOO_MANY_WRITES_OWNER_MESSAGE = `Aman stopped after ${String(MAX_CALENDAR_WRITES_PER_TURN)} calendar changes in one turn. Ask again to make more.`;

/** Any call that changes a calendar, whichever connector carries it. A call refused before it ran is not one. */
export function isCalendarWriteCall(
  info: Pick<InternalToolCallInfo, 'tier_reason' | 'type' | 'original_tool_name' | 'pre_dispatch_failure'>,
): boolean {
  if (info.pre_dispatch_failure !== undefined) {
    return false;
  }
  return (
    (info.tier_reason !== undefined && CALENDAR_WRITE_REASONS.has(info.tier_reason)) ||
    (info.type === 'mcp' && isCalendarChangeToolName(info.original_tool_name))
  );
}

function writeSignature(call: InternalEnrichedToolCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    args = call.function.arguments;
  }
  return stableStringify([call.tool_info.mcp_server_id, call.tool_info.original_tool_name, args]);
}

/**
 * The calendar changes in one model reply that must not run, by call id: an exact repeat of a change this turn
 * already let through, and every change past the per-turn limit. `earlier` is this turn's earlier calls with the
 * decisions recorded for them; a change counts once it ran without asking or was allowed. Changes still waiting in
 * this reply count too, so a reply cannot ask for more cards than the limit.
 */
export function calendarWriteBudgetBlocks(input: {
  earlier: readonly InternalEnrichedToolCall[];
  decisions: ReadonlyMap<string, ApprovalDecision>;
  calls: readonly InternalEnrichedToolCall[];
}): Map<string, { message: string; owner_message: string }> {
  const seen = new Set<string>();
  for (const call of input.earlier) {
    if (!isCalendarWriteCall(call.tool_info)) {
      continue;
    }
    if (call.tool_info.is_approval_required === true && input.decisions.get(call.id)?.status !== 'allow') {
      continue;
    }
    seen.add(writeSignature(call));
  }
  let count = seen.size;
  const blocks = new Map<string, { message: string; owner_message: string }>();
  for (const call of input.calls) {
    if (!isCalendarWriteCall(call.tool_info)) {
      continue;
    }
    const signature = writeSignature(call);
    if (seen.has(signature)) {
      blocks.set(call.id, { message: REPEATED_WRITE_MESSAGE, owner_message: REPEATED_WRITE_OWNER_MESSAGE });
      continue;
    }
    if (count >= MAX_CALENDAR_WRITES_PER_TURN) {
      blocks.set(call.id, { message: TOO_MANY_WRITES_MESSAGE, owner_message: TOO_MANY_WRITES_OWNER_MESSAGE });
      continue;
    }
    seen.add(signature);
    count += 1;
  }
  return blocks;
}
