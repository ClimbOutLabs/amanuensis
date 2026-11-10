import { EventType, type TerminalTurnState } from '@truefoundry/trueforge-core/agent-session';
import type { ToolApprovalRequiredEvent } from '@truefoundry/trueforge-core/core/events/schema';
import {
  isMorningBriefSchedule,
  MORNING_BRIEF_SCHEDULE_NAME,
  parseMorningBrief,
} from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import type { Logger } from 'winston';

import type { IDeliveryStore } from '../../db/deliveryStore';
import type { DeliveryLink } from '../../schemas/deliveries';
import type { DeliveryService } from './deliveryService';

/**
 * Where a finished turn came from. A turn that started in Telegram is answered there, with its own
 * buttons, so it never makes a delivery here.
 */
export type TurnDeliveryOrigin =
  | { type: 'chat' }
  | { type: 'telegram' }
  | { type: 'schedule'; name: string; task: string; scheduled_for: string; timezone: string };

/** A turn that reached its finished state, with its answer and the actions it still waits on. */
export interface TurnFinishedNotice {
  tenant_id: string;
  created_by: string;
  session_id: string;
  state: Extract<TerminalTurnState, { status: 'done' }>;
  origin: TurnDeliveryOrigin;
}

/** Watches finished turns and puts what a person would want to hear about into their feed. */
export interface TurnDeliveryObserver {
  turnFinished(notice: TurnFinishedNotice): Promise<void>;
}

type WaitingCall = ToolApprovalRequiredEvent['tool_calls'][number];

/** The plain text of a finished turn's answer, the same reading the artifact step makes of it. */
function answerText(state: TurnFinishedNotice['state']): string {
  const content = state.output?.content;
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return content.map(part => (part.type === 'text' ? part.text : part.refusal)).join('\n');
}

function briefReason(origin: Extract<TurnDeliveryOrigin, { type: 'schedule' }>): string {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: origin.timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(origin.scheduled_for));
  return origin.name === MORNING_BRIEF_SCHEDULE_NAME
    ? `Your morning brief ran at ${time}.`
    : `Your "${origin.name}" brief ran at ${time}.`;
}

function waitingReason(origin: TurnDeliveryOrigin): string {
  return origin.type === 'schedule'
    ? `The "${origin.name}" schedule ran and is waiting for your ok.`
    : 'A chat you left is waiting for your ok.';
}

/** The headline of one waiting call: its card's plain sentence, and nothing else the card carries. */
function callHeadline(call: WaitingCall): string | undefined {
  const what = call.tier3_card?.plain_what;
  return what === undefined || what.trim() === '' ? undefined : what;
}

function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/** The text of one waiting entry: the first call's headline, with the rest counted, never named. */
function entryText(calls: readonly WaitingCall[]): string {
  let headline: string | undefined;
  for (const call of calls) {
    headline = callHeadline(call);
    if (headline !== undefined) {
      break;
    }
  }
  const first = headline ?? 'An action is waiting for your ok.';
  const more = calls.length - 1;
  if (more === 0) {
    return first;
  }
  return `${sentence(first)} And ${String(more)} more ${more === 1 ? 'is' : 'are'} waiting.`;
}

/**
 * The two producers that watch finished turns: a brief schedule's run leaves its digest in the
 * feed, and a turn that ends still waiting on the person's ok leaves one item per waiting card.
 * The store has no dedupe, so each producer looks for its own delivery before creating one; a
 * completion seen twice, or a dispatch retried after a restart, still makes exactly one.
 * Never throws: a failure is logged, and the turn is never affected by its deliveries.
 */
export function createTurnDeliveryObserver({
  store,
  deliveries,
  logger,
}: {
  store: Pick<IDeliveryStore, 'findByKindAndLink'>;
  deliveries: Pick<DeliveryService, 'deliver'>;
  logger: Logger;
}): TurnDeliveryObserver {
  async function deliverBrief(notice: TurnFinishedNotice): Promise<void> {
    const { origin } = notice;
    if (origin.type !== 'schedule') {
      return;
    }
    if (!isMorningBriefSchedule({ name: origin.name, task: origin.task })) {
      return;
    }
    // Parse only: an answer that does not read as a brief makes no delivery, and no summary is invented.
    const brief = parseMorningBrief(answerText(notice.state));
    if (brief === null) {
      return;
    }
    const owner = { tenant_id: notice.tenant_id, created_by: notice.created_by };
    const link: DeliveryLink = { type: 'chat', session_id: notice.session_id };
    if ((await store.findByKindAndLink({ ...owner, kind: 'brief', link })) !== undefined) {
      return;
    }
    await deliveries.deliver({
      ...owner,
      kind: 'brief',
      level: 'nudge',
      text: brief.digest,
      reason: briefReason(origin),
      link,
    });
  }

  async function deliverWaiting(notice: TurnFinishedNotice): Promise<void> {
    if (notice.origin.type === 'telegram') {
      return;
    }
    const owner = { tenant_id: notice.tenant_id, created_by: notice.created_by };
    for (const action of notice.state.required_actions) {
      if (action.type !== EventType.TOOL_APPROVAL_REQUIRED) {
        continue;
      }
      // A call the run could not save for the owner cannot be answered, so it is not waiting.
      const calls = action.tool_calls.filter(call => call.not_saved === undefined);
      if (calls.length === 0) {
        continue;
      }
      const link: DeliveryLink = { type: 'approval', session_id: notice.session_id, approval_id: action.id };
      if ((await store.findByKindAndLink({ ...owner, kind: 'approval_waiting', link })) !== undefined) {
        continue;
      }
      await deliveries.deliver({
        ...owner,
        kind: 'approval_waiting',
        level: 'nudge',
        text: entryText(calls),
        reason: waitingReason(notice.origin),
        link,
      });
    }
  }

  return {
    async turnFinished(notice) {
      try {
        await deliverBrief(notice);
        await deliverWaiting(notice);
      } catch (error) {
        logger.warn('Could not make the deliveries for a finished turn', {
          session_id: notice.session_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
