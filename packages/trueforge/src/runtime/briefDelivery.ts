import { isMorningBriefSchedule, parseMorningBrief } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import type { Logger } from 'winston';

import type { ScheduleDispatchItem } from '../db/scheduleStore';
import type { DeliveryService } from './delivery/deliveryService';
import { formatRunTime } from './scheduleCapability';

/** What the bell says when the brief's answer has no digest sentence to show. */
export const BRIEF_READY_FALLBACK_TEXT = 'Your morning brief is ready.';

/** One bell item per run, so a run seen twice or retried after a restart still makes one. */
export function briefDeliveryId(runId: string): string {
  return `brief_${runId}`;
}

/** Whether this scheduled run is a morning brief, whose finished answer leaves a line in the bell. */
export function isBriefRun(item: ScheduleDispatchItem): boolean {
  return isMorningBriefSchedule({ name: item.schedule.name, task: item.schedule.manifest.task });
}

/**
 * Puts one line about a finished brief in the owner's bell, linked to the brief's chat. It is a note, so it never
 * pushes, never texts and never counts toward the day's nudges. An empty answer makes nothing. Never throws.
 */
export async function deliverBriefReady(params: {
  item: ScheduleDispatchItem;
  session_id: string;
  answer: string;
  deliveries: Pick<DeliveryService, 'deliverOnce'>;
  logger: Logger;
}): Promise<void> {
  const { item, session_id, answer, logger } = params;
  if (answer.trim() === '') {
    return;
  }
  const { schedule, run } = item;
  const ran = formatRunTime({ at: new Date(run.scheduled_for), timezone: schedule.manifest.timezone });
  try {
    await params.deliveries.deliverOnce({
      tenant_id: schedule.tenant_id,
      created_by: schedule.created_by_subject.subject_id,
      id: briefDeliveryId(run.id),
      kind: 'note',
      level: 'note',
      text: parseMorningBrief(answer)?.brief.digest ?? BRIEF_READY_FALLBACK_TEXT,
      reason: `Your morning brief ran on ${ran}.`,
      link: { type: 'chat', session_id },
    });
  } catch (error) {
    // The brief is still on Home and in its chat; only the bell line is missing.
    logger.warn('Could not put a finished brief in the bell', {
      schedule_id: schedule.id,
      run_id: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
