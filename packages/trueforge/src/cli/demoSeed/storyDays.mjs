// The demo story's calendar: the one owner of "today", day arithmetic, day labels and every
// day offset the story uses. Plain JavaScript so the Node mail tools can import it; storyDays.d.mts
// types it for the TypeScript seed.

// Every date in the demo mail and world is counted from one day: "today" in Lisbon, or --today.
export const DEMO_TIME_ZONE = 'Europe/Lisbon';

/**
 * Days from the anchor day ("today"); negative values are days before it. Mail offsets say when a
 * message was sent, the others when the thing it names happens, so the story keeps its gaps and
 * its weekday names on any day of the week.
 */
export const STORY = Object.freeze({
  TASK_FLIGHT_DONE: -17,
  TASK_RENTAL_DONE: -16,
  TASK_NIF_DONE: -8,
  TASK_BANK_DONE: -6,
  TASK_AIMA_DONE: -4,
  VISA_VISIT: 2,
  TOUR_FIRST_DAY: 1,
  TOUR_SECOND_DAY: 3,
  NEIGHBORHOOD_DECISION: 11,
  CAMERA_PICKUP: 3,
  GP_VISIT_EARLIEST: 3,
  FLIGHT_MAIL: -5,
  LISBON_FLIGHT: 19,
  GP_BOOKING_MAIL: -5,
  GP_CONSULTA_MAIL: -3,
  BILL_MAIL: -7,
  BILL_DUE: 11,
  METER_READING: 7,
  REPAIR_MAIL: -3,
  REPAIR_VISIT: 7,
  PACKAGE_MAIL: -2,
  PACKAGE_ARRIVES: 1,
  DINNER_MAIL: -3,
  DINNER_OPTION_A: 2,
  DINNER_OPTION_B: 4,
  CAMERA_MAIL: -4,
  PHISHING_MAIL: -1,
  TRIP_MAIL: -6,
  HIKE_DAY: 6,
  TRIP_CHANGE_MAIL: -4,
  REVIEW_INVITE_MAIL: -3,
  REVIEW_MEETING: 2,
  NOTE_MAIL: -1,
  PLUMBER_CALL_BY: 7,
  HOMEWORK_DUE: 2,
  HOMEWORK_MAIL: -7,
  BAKERY_MAIL: -3,
  BAKERY_PICKUP: 5,
  LUNCH_MAIL: -2,
  LUNCH_OPTION_A: 10,
  LUNCH_OPTION_B: 11,
  VISIT_START: 9,
  VISIT_END: 11,
  PHOTO_WALK_MAIL: -1,
  ALFAMA_SESSION: 4,
  GRACA_SESSION: 5,
  BELEM_SESSION: 12,
});

function partValue(parts, type) {
  const part = parts.find(candidate => candidate.type === type);
  if (part === undefined) {
    throw new Error(`Date formatting returned no ${type} part.`);
  }
  return Number(part.value);
}

/** The calendar day `now` falls on in `timeZone`. */
export function dayInZone({ now = new Date(), timeZone }) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  return { year: partValue(parts, 'year'), month: partValue(parts, 'month'), day: partValue(parts, 'day') };
}

/** The day a `YYYY-MM-DD` text names; throws for other text and for dates that do not exist, like 2026-02-30. */
export function parseDemoDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    throw new Error(`"${text}" is not a day written YYYY-MM-DD, such as 2026-10-19.`);
  }
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const stepped = addDays({ day, days: 0 });
  if (stepped.year !== day.year || stepped.month !== day.month || stepped.day !== day.day) {
    throw new Error(`"${text}" is not a real calendar day.`);
  }
  return day;
}

export function addDays({ day, days }) {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayIndex(day) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day, 12)).getUTCDay();
}

/**
 * The offset of the first Monday-to-Friday day at or after `offset` days from `today`. Appointments
 * use it, so a visit never falls on a weekend; `offset` must be ahead of today (1 or more).
 */
export function weekdayOffset({ today, offset }) {
  let shifted = offset;
  const isWeekend = weekday => weekday === 0 || weekday === 6;
  while (isWeekend(weekdayIndex(addDays({ day: today, days: shifted })))) {
    shifted += 1;
  }
  return shifted;
}

/** Named days are formatted from UTC noon, so no zone can move them to the day before. */
export function formatDay({ day, options, locale = 'en-US' }) {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(
    new Date(Date.UTC(day.year, day.month - 1, day.day, 12)),
  );
}

/** Calendar labels for the days around the anchor day, by offset from it. */
export function dayLabels(today) {
  const at = offset => addDays({ day: today, days: offset });
  const english = (day, options) => formatDay({ day, options });
  return {
    /** `Tuesday` */
    weekday: offset => english(at(offset), { weekday: 'long' }),
    /** `Oct 27` */
    monthDay: offset => english(at(offset), { month: 'short', day: 'numeric' }),
    /** `Tuesday, October 27` */
    long: offset => english(at(offset), { weekday: 'long', month: 'long', day: 'numeric' }),
    /** `Tuesday, October 27, 2026` */
    longYear: offset => english(at(offset), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  };
}
