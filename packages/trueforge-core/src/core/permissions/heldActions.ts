/**
 * Actions an unattended run holds for its owner instead of stopping at an approval card.
 *
 * Nothing is stored beside the turn: the held call keeps its exact arguments, card and approval
 * token in the persisted tool call, and approving later replays those bytes through the ordinary
 * dispatch checks. One expiry, owned by the approval token, bounds every held action.
 */
import { InvalidAgentSendInputError } from '../errors';
import type { InternalEnrichedAssistantMessage, InternalEnrichedToolCall, InternalToolCallInfo } from '../llm/LLMTypes';
import { gitRemotesMatch } from '../sandbox/gitRemoteObservation';
import {
  approvalTokenExpiry,
  stableStringify,
  type ApprovalTokenScope,
  type ApprovalTokenStore,
} from './approvalTokens';
import type { Tier3Card } from './tier';

/** Most actions one chat holds; past this a call is refused instead of queued. */
export const HELD_ACTION_CAP = 20;

/** Remediation code on the result of a call that was held, so hosts can tell it from other skips. */
export const HELD_REASON_CODE = 'held_for_owner';

/** What the model reads in place of a held call's result. */
export const HELD_RESULT_TEXT = JSON.stringify({
  held: "This action needs the owner's OK, so it was not run. It is saved for them to approve later. Do not retry it. Continue without it, and say in plain words that it is waiting for their OK. The app shows the approve buttons, so do not write them yourself.",
});

/** Why a call that needed the owner's OK was dropped instead of saved. */
export type NotSavedReason = 'too_many' | 'helper_agent';

const NOT_SAVED_MESSAGES: Record<NotSavedReason, string> = {
  helper_agent: "This action needs the owner's OK, but a helper agent cannot save it for later. Continue without it.",
  too_many: "Too many actions are already waiting for the owner's OK, so this one was not saved. Continue without it.",
};

/** The line the chat shows when the owner turns a held action down. */
export const HELD_DENIED_NOTE = 'Denied. Nothing was done.';

/**
 * The last words of a run that ends with actions waiting for its owner. `waiting` holds each action's
 * card sentence, so the owner learns what was held without opening the card.
 */
export function heldActionsNote(waiting: readonly string[]): string {
  const lines = waiting.map(sentence => sentence.trim().replace(/\.$/, ''));
  const [first = '', ...rest] = lines;
  if (rest.length === 0) {
    // A card sentence that already ends with a question mark keeps it; other
    // sentences get the stop the line needs before the next sentence.
    const firstWithStop = first.endsWith('?') ? first : `${first}.`;
    return `I need your OK for one thing: ${firstWithStop} Approve it on your Needs your OK list and I'll add it here.`;
  }
  return [
    `I need your OK for ${String(lines.length)} things:`,
    ...lines.map(line => `- ${line}`),
    "Approve them on your Needs your OK list and I'll add them here.",
  ].join('\n');
}

/** Why answering a held action was refused. The code travels to the client; the text is for logs and API users. */
export const HELD_REFUSAL_REASONS = ['expired', 'changed', 'not_allowed', 'tool_gone', 'sign_in'] as const;
export type HeldRefusalReason = (typeof HELD_REFUSAL_REASONS)[number];

const HELD_REFUSAL_MESSAGES: Record<HeldRefusalReason, string> = {
  expired: 'Expired, nothing was done. Ask again in chat.',
  changed: 'This no longer matches what was held, so nothing was done. Ask again in chat.',
  not_allowed: 'This is not allowed any more, so nothing was done. Ask again in chat.',
  tool_gone: 'This tool is not available any more, so nothing was done. Ask again in chat.',
  sign_in: 'The connector needs you to sign in again first, so nothing was done. Sign in, then try again.',
};

/** A held action cannot run now. Nothing was recorded or done. */
export class HeldActionRefusedError extends InvalidAgentSendInputError {
  readonly reason: HeldRefusalReason;

  constructor(reason: HeldRefusalReason, options?: ErrorOptions) {
    super(HELD_REFUSAL_MESSAGES[reason], options);
    this.name = 'HeldActionRefusedError';
    this.reason = reason;
  }
}

function sameCall(left: InternalEnrichedToolCall, right: InternalEnrichedToolCall): boolean {
  return left.function.name === right.function.name && left.function.arguments === right.function.arguments;
}

/**
 * Turns every call that would stop for approval into a held call. A held call is not asked about
 * and not dispatched; the run goes on without it. Calls that cannot be replayed later, or that
 * would pass the cap, are refused before dispatch instead and reported in "refused". An identical
 * call later in the same batch is marked a duplicate: it is neither listed nor counted again.
 *
 * Auto-denied calls keep their refusal and are never held.
 */
export function holdApprovalCalls(input: {
  message: InternalEnrichedAssistantMessage;
  /** Calls this chat already holds, counted toward the cap. */
  alreadyHeld: number;
  /** A helper agent's call cannot be replayed from the main chat, so it is refused. */
  isSubAgent: boolean;
}): { message: InternalEnrichedAssistantMessage; refused: { id: string; reason: NotSavedReason }[] } {
  const { message } = input;
  if (message.tool_calls === undefined) {
    return { message, refused: [] };
  }
  let held = input.alreadyHeld;
  const toolCalls: InternalEnrichedToolCall[] = [];
  const firstHeld: InternalEnrichedToolCall[] = [];
  const refused: { id: string; reason: NotSavedReason }[] = [];
  for (const call of message.tool_calls) {
    const info = call.tool_info;
    if (
      info.is_approval_required !== true ||
      info.pre_dispatch_failure !== undefined ||
      info.is_client_side === true ||
      info.is_thread_creation === true
    ) {
      toolCalls.push(call);
      continue;
    }
    const expires_at = approvalTokenExpiry();
    if (firstHeld.some(earlier => sameCall(earlier, call))) {
      toolCalls.push({
        ...call,
        tool_info: { ...info, is_approval_required: false, held_for_owner: { expires_at, duplicate: true } },
      });
    } else if (input.isSubAgent || held >= HELD_ACTION_CAP) {
      const reason: NotSavedReason = input.isSubAgent ? 'helper_agent' : 'too_many';
      refused.push({ id: call.id, reason });
      toolCalls.push({
        ...call,
        tool_info: {
          ...info,
          is_approval_required: false,
          pre_dispatch_failure: {
            kind: 'policy_blocked',
            message: NOT_SAVED_MESSAGES[reason],
            owner_message: NOT_SAVED_MESSAGES[reason],
          },
        },
      });
    } else {
      held += 1;
      const heldCall = {
        ...call,
        tool_info: { ...info, is_approval_required: false, held_for_owner: { expires_at } },
      };
      firstHeld.push(heldCall);
      toolCalls.push(heldCall);
    }
  }
  const changed = toolCalls.some((call, index) => call !== message.tool_calls?.[index]);
  return { message: changed ? { ...message, tool_calls: toolCalls } : message, refused };
}

export type HeldReplayCheck = { ok: true; approval_token_id: string | null } | { ok: false; reason: HeldRefusalReason };

/** A held git command runs against the remotes its owner was shown, so the ones seen again must be those. */
function heldRemotesUnchanged(input: { held: InternalToolCallInfo; fresh: InternalToolCallInfo }): boolean {
  const approved = input.held.git_remote_precondition;
  const current = input.fresh.git_remote_precondition;
  return approved === undefined || current === undefined
    ? approved === current
    : gitRemotesMatch({ approved, current });
}

/** A value with every empty part dropped, so "nothing to show" reads the same however it was stored. */
function withoutEmptyParts(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutEmptyParts);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, part]) => part !== null && part !== undefined)
        .map(([key, part]) => [key, withoutEmptyParts(part)]),
    );
  }
  return value;
}

/**
 * Everything a person reads on a card before approving. The two free-text reason lines are left out, and so is
 * a schedule's list of next runs, which moves with the clock.
 */
function partsRead(card: Tier3Card): Record<string, unknown> {
  return {
    ...card,
    plain_why: null,
    why_asked_again: null,
    schedule: card.schedule == null ? null : { ...card.schedule, next_runs: null },
  };
}

function asComparableText(parts: Record<string, unknown>): string {
  return stableStringify(withoutEmptyParts(parts));
}

/**
 * Whether a card reads today as it read when the call was held. One difference is expected: approving a mail to
 * new addresses puts them on the Email list, so a later try no longer carries the new-recipient notice. The
 * sentence after that notice, and every other part, must still be what the owner read.
 */
function readsAsHeld(input: { held: Tier3Card; fresh: Tier3Card }): boolean {
  const { held, fresh } = input;
  if (asComparableText(partsRead(held)) === asComparableText(partsRead(fresh))) {
    return true;
  }
  const noticedThen = held.mail_new_recipients ?? [];
  const noticedNow = fresh.mail_new_recipients ?? [];
  if (noticedThen.length === 0 || noticedNow.length > 0 || !held.plain_what.endsWith(` ${fresh.plain_what}`)) {
    return false;
  }
  const withoutNotice = { plain_what: fresh.plain_what, mail_new_recipients: null, mail_draft: null };
  return (
    asComparableText({ ...partsRead(held), ...withoutNotice }) ===
    asComparableText({ ...partsRead(fresh), ...withoutNotice })
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
    return { ok: false, reason: 'expired' };
  }
  if (fresh.pre_dispatch_failure !== undefined) {
    return { ok: false, reason: 'not_allowed' };
  }
  const heldTokenId = held.approval_token_id ?? null;
  const heldToken = heldTokenId === null ? undefined : await tokens.peek({ ...scope, token_id: heldTokenId });
  if (heldTokenId !== null && heldToken === undefined) {
    return { ok: false, reason: 'expired' };
  }
  const freshTokenId = fresh.approval_token_id ?? null;
  if (heldToken !== undefined && freshTokenId !== null) {
    const freshToken = await tokens.peek({ ...scope, token_id: freshTokenId });
    if (freshToken?.action_id !== heldToken.action_id) {
      return { ok: false, reason: 'changed' };
    }
  }
  if (!heldRemotesUnchanged({ held, fresh })) {
    return { ok: false, reason: 'changed' };
  }
  const heldCard = held.tier3_card ?? undefined;
  const freshCard = fresh.tier3_card ?? undefined;
  if (heldCard !== undefined && freshCard !== undefined && !readsAsHeld({ held: heldCard, fresh: freshCard })) {
    return { ok: false, reason: 'changed' };
  }
  // A fresh call that no longer asks (a standing grant was added meanwhile) runs without the token.
  return { ok: true, approval_token_id: freshTokenId === null ? null : (heldTokenId ?? freshTokenId) };
}
