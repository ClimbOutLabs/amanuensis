/**
 * The warning every grant of sites carries. Aman blocks the email services it knows, but it cannot tell
 * what any other site does with what it is sent.
 */
export const SKILL_SITES_DATA_WARNING =
  "Aman can't see what these sites do with what the skill sends them. Any of them could pass your data on, even by email, so only add a skill you trust.";

/** Shown when the list names a site that can send email: Aman blocks it whatever the answer. */
export const SKILL_SITES_EMAIL_BLOCKED =
  'Aman blocks the email sites on this list. A skill can never send email. Email only goes out through Aman, and you approve each one.';

/** How a blocked site is named in a list of sites. */
export function skillSiteLabel(input: { site: string; blocked: boolean }): string {
  return input.blocked ? `${input.site} (blocked)` : input.site;
}
