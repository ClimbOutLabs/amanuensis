/**
 * Tier rules for Aman's own browser. Every call the person did not type themselves is read-only:
 * opening a page, reading it, scrolling, going back and taking a screenshot never submit anything,
 * so they run without asking (Tier 1), the same way a mail read does.
 *
 * The one exception is steering: a page is untrusted content, exactly like an email. When the only
 * reason the assistant is about to open a link is that a page it read named it, the open asks first
 * instead of running silently, so a page cannot send the browser somewhere on its own say-so.
 */
import { BROWSER_EXPLORE_REASON, BROWSER_OPEN_TOOL_NAME, isBrowserToolName } from './browserToolNames';
import type { SentinelAction } from './classifier';
import type { ChatProvenance } from './provenance';
import { steeredUrl } from './provenance';
import { CONTENT_STEERED_REASON, tier1Decision, tier3Decision, type Tier3Card, type TierDecision } from './tier';

function steeredOpenCard(url: string): Tier3Card {
  return {
    plain_what: `Open ${url}?`,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: url,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
  };
}

/**
 * Tier rules for the browser's read-only tools, in the shape of `classifyCaldavTool`. Returns
 * undefined for any other tool, so the generic path classifies it (fail closed).
 */
export async function classifyBrowserTool({
  action,
  provenance,
  assistant,
  mintToken,
}: {
  action: Pick<SentinelAction, 'tool_name' | 'canonical_params' | 'tool_type'>;
  provenance: ChatProvenance;
  /** The assistant's display name, for the sentence that says why it is asking. */
  assistant: string;
  mintToken: () => Promise<string>;
}): Promise<TierDecision | undefined> {
  if (action.tool_type !== 'truefoundry-system' || !isBrowserToolName(action.tool_name)) {
    return undefined;
  }
  if (action.tool_name === BROWSER_OPEN_TOOL_NAME) {
    const url = action.canonical_params['url'];
    // Opening the exact page a page named is the one case to flag: there is no link of the person's
    // own to compare, so a bare "it is in both lists" match (the check `steeredLinks` makes for an
    // outbound call that merely repeats a link) would never catch it.
    if (typeof url === 'string' && url !== '' && steeredUrl({ provenance, url })) {
      return tier3Decision({
        card: steeredOpenCard(url),
        reason: CONTENT_STEERED_REASON,
        reason_detail: `${assistant} would only open this because a page it read named it, not you.`,
        sensitive_read: false,
        approval_token_id: await mintToken(),
      });
    }
  }
  return tier1Decision({
    reason: BROWSER_EXPLORE_REASON,
    reason_detail: 'Reads or moves around in the browser. Nothing is submitted.',
    sensitive_read: false,
  });
}
