/**
 * The morning brief prompt. The tour card, the demo seed and any schedule the chat creates as a brief all send
 * this text, so every brief asks for the same things in the same order.
 */
export const MORNING_BRIEF_PROMPT =
  "Give me my morning brief. 1. Read everything new since my last brief, or the last 24 hours: all of it, page by page, not just the first few. Then today's and the next 7 days' calendar, the lists in my spaces, and what you remember about me. 2. Write four short sections, only what matters, most urgent first, one line per item. End each line with one next step in square brackets, such as [Draft a reply], and no more than one per line. Coming up: time, place, what to bring. Deadlines: date and what is due. Needs doing: replies I owe and tasks, each with a suggested next step. Watch out: anything that looks like a scam or is unusual, with the warning signs. 3. Say where each item came from. Offer next steps (draft a reply, plan the route, add to a list), but do not send or save anything without asking me. 4. If something could not be read, say so in one line instead of guessing.";

const MORNING_BRIEF_OPENING = 'Give me my morning brief.';

/** Whether a user message is a morning brief request, by the opening that every brief prompt shares. */
export function isMorningBriefPrompt(text: string): boolean {
  return text.startsWith(MORNING_BRIEF_OPENING);
}
