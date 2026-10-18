import type { CalendarDay } from '@truefoundry/trueforge-core/core/util/calendarDay';
import { dayLabels } from '../calendar';

/** Monday 19 October 2026, "today" in Maya's demo mailbox; her mail and calendar date everything from it. */
export const MAYA_MAILBOX_DAY: CalendarDay = { year: 2026, month: 10, day: 19 };

/** Labels counted from the mailbox day, so a date in her world matches the same date in her mail and calendar. */
export const MAYA_DAYS = dayLabels(MAYA_MAILBOX_DAY);
