/**
 * Actions an unattended run holds for its owner instead of stopping at an approval card.
 *
 * Nothing is stored beside the turn: the held call keeps its exact arguments, card and approval
 * token in the persisted tool call, and approving later replays those bytes through the ordinary
 * dispatch checks. One expiry, owned by the approval token, bounds every held action.
 */
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall, InternalToolCallInfo } from '../llm/LLMTypes';
import { approvalTokenExpiry, type ApprovalTokenScope, type ApprovalTokenStore } from './approvalTokens';
import type { Tier3Card } from './tier';

/** Most actions one chat holds; past this a call is refused instead of queued. */
export const HELD_ACTION_CAP = 20;

/** Remediation code on the result of a call that was held, so hosts can tell it from other skips. */
export const HELD_REASON_CODE = 'held_for_owner';

/** What the model reads in place of a held call's result. */
export const HELD_RESULT_TEXT = JSON.stringify({
  held: "This action needs the owner's OK, so it was not run. It is saved for them to approve later. Do not retry it. Continue without it, and say in plain words that it is waiting for their OK. The app shows the approve buttons, so do not write them yourself.",
});

const HELPER_AGENT_REFUSED_MESSAGE =
  "This action needs the owner's OK, but a helper agent cannot save it for later. Continue without it.";
const CAP_REFUSED_MESSAGE =
  "Too many actions are already waiting for the owner's OK, so this one was not saved. Continue without it.";

/** The line the chat shows when the owner turns a held action down. */
export const HELD_DENIED_NOTE = 'Denied. Nothing was done.';

export const HELD_EXPIRED_MESSAGE = 'Expired, nothing was done. Ask again in chat.';
export const HELD_CHANGED_MESSAGE = 'This no longer matches what was held, so nothing was done. Ask again in chat.';
export const HELD_NOT_ALLOWED_MESSAGE = 'This is not allowed any more, so nothing was done. Ask again in chat.';
export const HELD_SIGN_IN_MESSAGE =
  'The connector needs you to sign in again first, so nothing was done. Sign in, then try again.';
export const HELD_TOOL_GONE_MESSAGE = 'This tool is not available any more, so nothing was done. Ask again in chat.';

export function isHeldForOwner(info: InternalToolCallInfo): boolean {
  return info.held_for_owner !== undefined;
}

/**
 * Turns every call that would stop for approval into a held call. A held call is not asked about
 * and not dispatched; the run goes on without it. Calls that cannot be replayed later, or that
 * would pass the cap, are refused before dispatch instead.
 *
 * Auto-denied calls keep their refusal and are never held. That is how Gmail writes stay unholdable.
 */
export function holdApprovalCalls(input: {
  message: InternalEnrichedAssistantMessage;
  /** Calls this chat already holds, counted toward the cap. */
  alreadyHeld: number;
  /** A helper agent's call cannot be replayed from the main chat, so it is refused. */
  isSubAgent: boolean;
}): InternalEnrichedAssistantMessage {
  const { message } = input;
  if (message.tool_calls === undefined) {
    return message;
  }
  let held = input.alreadyHeld;
  const toolCalls: InternalEnrichedToolCall[] = [];
  for (const call of message.tool_calls) {
    const info = call.tool_info;
    if (
      info.is_approval_required !== true ||
      info.pre_dispatch_failure !== undefined ||
      info.is_client_side === true ||
      info.is_thread_creation === true
    ) {
      toolCalls.push(call);
    } else if (input.isSubAgent || held >= HELD_ACTION_CAP) {
      toolCalls.push({
        ...call,
        tool_info: {
          ...info,
          is_approval_required: false,
          pre_dispatch_failure: {
            kind: 'policy_blocked',
            message: input.isSubAgent ? HELPER_AGENT_REFUSED_MESSAGE : CAP_REFUSED_MESSAGE,
          },
        },
      });
    } else {
      held += 1;
      toolCalls.push({
        ...call,
        tool_info: { ...info, is_approval_required: false, held_for_owner: { expires_at: approvalTokenExpiry() } },
      });
    }
  }
  return toolCalls.every((call, index) => call === message.tool_calls?.[index])
    ? message
    : { ...message, tool_calls: toolCalls };
}

export type HeldReplayCheck = { ok: true; approval_token_id: string | null } | { ok: false; message: string };

/** The card fields a person reads before approving; free text such as the reason is not compared. */
function sameCardTargets(held: Tier3Card, fresh: Tier3Card): boolean {
  return (
    held.recipient === fresh.recipient &&
    held.destination === fresh.destination &&
    held.destination_host === fresh.destination_host &&
    held.outbound_text === fresh.outbound_text &&
    held.parsed_command === fresh.parsed_command
  );
}

/**
 * Decides whether a held call may run now. `held` is the call as it was held and `fresh` the same
 * bytes classified again, so a rule that changed since still applies. Refuses when the hold or its
 * token ran out, when the call is now auto-denied, or when what it would do is no longer what the
 * owner was shown. The caller re-stamps the fresh call with the returned hold-time token.
 */
export async function checkHeldReplay(input: {
  held: InternalToolCallInfo;
  fresh: InternalToolCallInfo;
  tokens: ApprovalTokenStore;
  scope: ApprovalTokenScope;
}): Promise<HeldReplayCheck> {
  const { held, fresh, tokens, scope } = input;
  if (held.held_for_owner === undefined || Date.parse(held.held_for_owner.expires_at) <= Date.now()) {
    return { ok: false, message: HELD_EXPIRED_MESSAGE };
  }
  if (fresh.pre_dispatch_failure !== undefined) {
    return { ok: false, message: HELD_NOT_ALLOWED_MESSAGE };
  }
  const heldTokenId = held.approval_token_id ?? null;
  const heldToken = heldTokenId === null ? undefined : await tokens.peek({ ...scope, token_id: heldTokenId });
  if (heldTokenId !== null && heldToken === undefined) {
    return { ok: false, message: HELD_EXPIRED_MESSAGE };
  }
  const freshTokenId = fresh.approval_token_id ?? null;
  if (heldToken !== undefined && freshTokenId !== null) {
    const freshToken = await tokens.peek({ ...scope, token_id: freshTokenId });
    if (freshToken?.action_id !== heldToken.action_id) {
      return { ok: false, message: HELD_CHANGED_MESSAGE };
    }
  }
  const heldCard = held.tier3_card ?? undefined;
  const freshCard = fresh.tier3_card ?? undefined;
  if (heldCard !== undefined && freshCard !== undefined && !sameCardTargets(heldCard, freshCard)) {
    return { ok: false, message: HELD_CHANGED_MESSAGE };
  }
  // A fresh call that no longer asks (a standing grant was added meanwhile) runs without the token.
  return { ok: true, approval_token_id: freshTokenId === null ? null : (heldTokenId ?? freshTokenId) };
}
