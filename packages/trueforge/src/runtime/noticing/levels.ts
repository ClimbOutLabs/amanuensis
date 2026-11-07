import type { DeliveryLevel } from '../../schemas/deliveries';
import type { NoticingEvidence, NoticingKind } from '../../schemas/reach';

const RANK: Record<DeliveryLevel, number> = { note: 0, nudge: 1, call: 2 };

/** The quieter of two levels. */
export function lowerOf({ left, right }: { left: DeliveryLevel; right: DeliveryLevel }): DeliveryLevel {
  return RANK[left] <= RANK[right] ? left : right;
}

/**
 * The highest level each kind of event can ever reach, whatever the model says or the person ticked. A bill or a
 * waiting approval may nudge but never calls. A person's tick only unlocks `call` for the kinds that may reach it.
 */
export const KIND_MAX_LEVEL: Record<NoticingKind, DeliveryLevel> = {
  mail_always: 'call',
  calendar_clash: 'call',
  travel: 'call',
  bill_due: 'nudge',
  approval_waiting: 'nudge',
};

/** What an event's evidence alone allows: text that only claimed something can raise a note and nothing more. */
export function evidenceCeiling(evidence: NoticingEvidence): DeliveryLevel {
  return evidence === 'content' ? 'note' : 'call';
}

/** The most an event can reach given its kind and its evidence, before the person's own rules. */
export function ceilingOf({ kind, evidence }: { kind: NoticingKind; evidence: NoticingEvidence }): DeliveryLevel {
  return lowerOf({ left: KIND_MAX_LEVEL[kind], right: evidenceCeiling(evidence) });
}

/** Each kind in plain words, for the sentences a person reads about it. */
export const KIND_WORDS: Record<NoticingKind, string> = {
  mail_always: 'mail from someone you marked always important',
  calendar_clash: 'two things on your calendar at the same time',
  travel: 'an event you need to leave for',
  bill_due: 'a bill or deadline coming up',
  approval_waiting: 'an approval waiting for you',
};
