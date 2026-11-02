/**
 * Tier rules for Aman's own browser. Reading, scrolling, going back and taking a screenshot only
 * look at the page already open and never submit anything, so they run without asking (Tier 1), the
 * same way a mail read does.
 *
 * Opening a page is different: the address itself goes to the site, so whatever is in it leaves
 * with the request. `browser_open` is classified in classifier.ts (`classifyBrowserOpen`) with the
 * same outbound checks a search provider's page read gets, and this module only supplies its card.
 */
import { BROWSER_EXPLORE_REASON, BROWSER_OPEN_TOOL_NAME, isBrowserToolName } from './browserToolNames';
import type { SentinelAction } from './classifier';
import { tier1Decision, type Tier3Card, type TierDecision } from './tier';

/** The card for an open that asks: the exact address, which is everything the open sends, and the site it goes to. */
export function browserOpenCard(input: {
  url: string;
  host: string | null;
  plain_what: string;
  plain_why: string | null;
}): Tier3Card {
  return {
    plain_what: input.plain_what,
    plain_why: input.plain_why,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: input.url,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: input.url,
    destination_host: input.host,
    outbound_truncated: false,
  };
}

/**
 * Tier rules for the browser's tools that only look at the open page. Returns undefined for
 * `browser_open` (classified on its own) and for any other tool, so the generic path classifies it
 * (fail closed).
 */
export function classifyBrowserViewTool(
  action: Pick<SentinelAction, 'tool_name' | 'tool_type'>,
): TierDecision | undefined {
  if (
    action.tool_type !== 'truefoundry-system' ||
    !isBrowserToolName(action.tool_name) ||
    action.tool_name === BROWSER_OPEN_TOOL_NAME
  ) {
    return undefined;
  }
  return tier1Decision({
    reason: BROWSER_EXPLORE_REASON,
    reason_detail: 'Reads or moves around in the open page. Nothing is submitted.',
    sensitive_read: false,
  });
}
