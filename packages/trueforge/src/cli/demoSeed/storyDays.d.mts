/** Types for storyDays.mjs, the demo story's calendar owner. */

export const DEMO_TIME_ZONE: string;

export const STORY: {
  readonly TASK_FLIGHT_DONE: number;
  readonly TASK_RENTAL_DONE: number;
  readonly TASK_NIF_DONE: number;
  readonly TASK_BANK_DONE: number;
  readonly TASK_AIMA_DONE: number;
  readonly VISA_VISIT: number;
  readonly TOUR_FIRST_DAY: number;
  readonly TOUR_SECOND_DAY: number;
  readonly NEIGHBORHOOD_DECISION: number;
  readonly CAMERA_PICKUP: number;
  readonly GP_VISIT: number;
  readonly FLIGHT_MAIL: number;
  readonly LISBON_FLIGHT: number;
  readonly GP_BOOKING_MAIL: number;
  readonly GP_CONSULTA_MAIL: number;
  readonly BILL_MAIL: number;
  readonly BILL_DUE: number;
  readonly METER_READING: number;
  readonly REPAIR_MAIL: number;
  readonly REPAIR_VISIT: number;
  readonly PACKAGE_MAIL: number;
  readonly PACKAGE_ARRIVES: number;
  readonly DINNER_MAIL: number;
  readonly DINNER_OPTION_A: number;
  readonly DINNER_OPTION_B: number;
  readonly CAMERA_MAIL: number;
  readonly PHISHING_MAIL: number;
  readonly TRIP_MAIL: number;
  readonly HIKE_DAY: number;
  readonly TRIP_CHANGE_MAIL: number;
  readonly REVIEW_INVITE_MAIL: number;
  readonly REVIEW_MEETING: number;
  readonly NOTE_MAIL: number;
  readonly PLUMBER_CALL_BY: number;
  readonly HOMEWORK_DUE: number;
  readonly HOMEWORK_MAIL: number;
  readonly BAKERY_MAIL: number;
  readonly BAKERY_PICKUP: number;
  readonly LUNCH_MAIL: number;
  readonly LUNCH_OPTION_A: number;
  readonly LUNCH_OPTION_B: number;
  readonly VISIT_START: number;
  readonly VISIT_END: number;
  readonly PHOTO_WALK_MAIL: number;
  readonly ALFAMA_SESSION: number;
  readonly GRACA_SESSION: number;
  readonly BELEM_SESSION: number;
};

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

export interface DayLabels {
  /** `Tuesday` */
  weekday(offset: number): string;
  /** `Oct 27` */
  monthDay(offset: number): string;
  /** `Tuesday, October 27` */
  long(offset: number): string;
  /** `Tuesday, October 27, 2026` */
  longYear(offset: number): string;
}

export function dayInZone(options: { now?: Date; timeZone: string }): CalendarDay;
export function parseDemoDay(text: string): CalendarDay;
export function addDays(options: { day: CalendarDay; days: number }): CalendarDay;
export function isoDay(day: CalendarDay): string;
export function formatDay(options: { day: CalendarDay; options: Intl.DateTimeFormatOptions; locale?: string }): string;
export function dayLabels(today: CalendarDay): DayLabels;
