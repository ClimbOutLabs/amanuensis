import type { DeliveryLevel } from '../../schemas/deliveries';
import type { NoticingEvidence, NoticingKind, ReachSettings } from '../../schemas/reach';
import { evidenceCeiling, KIND_MAX_LEVEL, KIND_WORDS, lowerOf } from './levels';
import { isQuietNow } from './quietHours';

/** What the person's recent days say about how much has already reached them. */
export interface ReachHistory {
  /** Nudges about what the assistant noticed, delivered since the person's day began. Reminders are not counted. */
  nudges_today: number;
  /** When something last went out as a call, or undefined when nothing has. */
  last_call_at: Date | undefined;
}

export interface ReachDecision {
  /** The level after the person's rules. A later part's phone channel acts on `call` here. */
  decided: DeliveryLevel;
  /** The level that goes out now. Differs from `decided` while a channel is not set up, or a daily limit is reached. */
  delivered: DeliveryLevel;
  /** Each time a rule lowered the level, in plain words, in the order the rules ran. */
  steps: string[];
}

/** What is being decided: a watched event, or a reminder the person set, which is never quieter than a nudge. */
export type ReachSubject = { kind: NoticingKind; evidence: NoticingEvidence } | { kind: 'reminder'; urgent: boolean };

/**
 * The person's rules, applied in code to whatever level was asked for. A model can only ask: nothing here reads the
 * model's words, so no wording in a message or a verdict can lift a level past these rules. `calls_available` is
 * true once a later part sets up a phone channel; until then a call that survives is delivered as a nudge.
 */
export function applyReachRules({
  subject,
  asked,
  settings,
  history,
  now,
  calls_available,
}: {
  subject: ReachSubject;
  asked: DeliveryLevel;
  settings: ReachSettings;
  history: ReachHistory;
  now: Date;
  calls_available: boolean;
}): ReachDecision {
  const steps: string[] = [];
  let level = asked;
  const lower = (to: DeliveryLevel, why: string): void => {
    const next = lowerOf({ left: level, right: to });
    if (next !== level) {
      level = next;
      steps.push(why);
    }
  };

  if (subject.kind !== 'reminder') {
    lower(
      KIND_MAX_LEVEL[subject.kind],
      `${capitalized(KIND_WORDS[subject.kind])} can reach you at most as a ${KIND_MAX_LEVEL[subject.kind]}.`,
    );
    lower(evidenceCeiling(subject.evidence), 'Only the words in a message said this mattered, so it stays a note.');
  }

  if (level === 'call') {
    if (
      subject.kind === 'reminder'
        ? !(subject.urgent && settings.call_for_urgent_reminders)
        : !settings.call_kinds.includes(subject.kind)
    ) {
      level = 'nudge';
      steps.push(
        subject.kind === 'reminder'
          ? 'Calls for reminders you mark urgent are not turned on.'
          : 'You have not allowed calls for this kind of event.',
      );
    } else if (!settings.channels.calls) {
      level = 'nudge';
      steps.push('Calls are switched off in Reach me.');
    } else if (isQuietNow({ now, quiet: settings.quiet_hours, timezone: settings.timezone })) {
      level = 'nudge';
      steps.push('It is during your quiet hours, so no call.');
    } else if (
      history.last_call_at !== undefined &&
      now.getTime() - history.last_call_at.getTime() < settings.min_hours_between_calls * 3_600_000
    ) {
      level = 'nudge';
      steps.push(`You already had a call in the last ${String(settings.min_hours_between_calls)} hours.`);
    }
  }

  const decided = level;
  if (level === 'call' && !calls_available) {
    level = 'nudge';
    steps.push('Phone calls are not set up yet, so it came as a nudge.');
  }
  // A reminder was asked for by the person, so the daily nudge limit never turns it into a note.
  if (subject.kind !== 'reminder' && level === 'nudge' && history.nudges_today >= settings.max_nudges_per_day) {
    level = 'note';
    steps.push(`You have had ${String(history.nudges_today)} nudges today, which is your limit, so it came as a note.`);
  }
  return { decided, delivered: level, steps };
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The most a delivery's reason holds. */
const REASON_MAX = 500;

/** Joins the sentences that explain a delivery into one reason, cut to what a delivery holds. */
export function joinReasons(parts: readonly string[]): string {
  const text = parts
    .map(part => part.trim())
    .filter(part => part !== '')
    .join(' ');
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1).trimEnd()}\u2026`;
}
