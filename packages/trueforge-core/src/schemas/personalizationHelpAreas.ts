/**
 * Fixed ids for the "What would help you most?" choices. The server stores and validates them and
 * the Tour labels them, so both read them from here.
 */
export const HELP_AREA_IDS = ['focus', 'family', 'caring', 'new_country', 'work_money', 'productivity'] as const;
export type HelpAreaId = (typeof HELP_AREA_IDS)[number];
