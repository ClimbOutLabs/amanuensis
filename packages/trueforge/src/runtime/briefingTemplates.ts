/**
 * Briefing prompt templates for `briefing` schedule kinds. The agent turn runs
 * with the template prompt as its first user message; the turn output is then
 * delivered as a notification.
 */
import type { BriefingTemplate } from '../schemas/schedule';

/**
 * Morning briefing: calendar, overnight updates, priorities, weather.
 * The schedule runs in the schedule's session with the schedule's tools and
 * skills, so the agent gathers current information rather than guessing.
 */
const MORNING_BRIEFING_PROMPT = `You are preparing the user's morning briefing. Write a concise briefing covering:

1. Today's calendar: list today's events with times, highlighting anything starting within the next 2 hours.
2. Overnight updates: summarize important new emails, messages, or alerts received since yesterday evening.
3. Priorities: suggest the top 3 things to focus on today based on the calendar and pending work.
4. Weather: today's forecast for the user's location, flagging anything that affects plans.

Keep it scannable: short sections with headers, bullet points, no fluff. If a section has nothing relevant, say so in one line and move on. Use the tools available to you (calendar, email, weather) to gather current information rather than guessing.`;

/** Build the first user message for a briefing schedule run. */
export function buildBriefingPrompt(template: BriefingTemplate): string {
  switch (template) {
    case 'morning-briefing':
      return MORNING_BRIEFING_PROMPT;
  }
}
