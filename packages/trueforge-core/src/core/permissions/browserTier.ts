/**
 * Tier rules for Aman's own browser. Every call the person did not type themselves is read-only:
 * opening a page, reading it, scrolling, going back and taking a screenshot never submit anything,
 * so they run without asking (Tier 1), the same way a mail read does. Typing into a field and
 * picking an option are Tier 1 too: nothing has left the computer yet.
 *
 * A click is the one call that may submit something. It is Tier 3 (a card first) when it submits a
 * form, or when its accessible name matches a commit word (pay, buy, cancel a membership, and so
 * on); otherwise it is Tier 1, the same as following a link or opening a tab.
 *
 * The other exception is steering: a page is untrusted content, exactly like an email. When the only
 * reason the assistant is about to open a link is that a page it read named it, the open asks first
 * instead of running silently, so a page cannot send the browser somewhere on its own say-so.
 */
import type { BrowserClickReview } from '../llm/LLMTypes';
import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_COMMIT_REASON,
  BROWSER_EXPLORE_REASON,
  BROWSER_OPEN_TOOL_NAME,
  BROWSER_PREPARE_REASON,
  BROWSER_SELECT_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
  isBrowserToolName,
} from './browserToolNames';
import type { SentinelAction } from './classifier';
import { escapeDisplayText } from './displayText';
import { renderOutboundArguments } from './extractorRegistry';
import type { ChatProvenance } from './provenance';
import { steeredUrl } from './provenance';
import { CONTENT_STEERED_REASON, tier1Decision, tier3Decision, type Tier3Card, type TierDecision } from './tier';

/**
 * Single words that mark a click as a commit, whatever element carries them. Kept in one place, with
 * tests covering each one.
 */
export const BROWSER_COMMIT_WORDS: readonly string[] = [
  'pay',
  'buy',
  'purchase',
  'order',
  'checkout',
  'confirm',
  'submit',
  'send',
  'delete',
  'remove',
  'unsubscribe',
  'subscribe',
  'transfer',
  'book',
  'reserve',
  'accept',
  'agree',
];

/** Multi-word commit phrases that are not single words on their own. */
const BROWSER_COMMIT_PHRASES: readonly string[] = ['sign up'];

/**
 * "Cancel" alone closes any ordinary dialog (a form's own Cancel button, a modal's close button) and
 * is not a commit word by itself; it is one only together with what it cancels, so "Cancel" on a
 * dialog never asks while "Cancel membership" always does.
 */
export const BROWSER_CANCEL_QUALIFIERS: readonly string[] = ['membership', 'subscription', 'plan', 'order', 'account'];

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text);
}

/** Whether an element's accessible name matches a commit word or phrase. */
export function matchesCommitWord(accessibleName: string): boolean {
  const text = normalizedName(accessibleName);
  if (BROWSER_COMMIT_WORDS.some(word => hasWord(text, word))) {
    return true;
  }
  if (BROWSER_COMMIT_PHRASES.some(phrase => text.includes(phrase))) {
    return true;
  }
  return hasWord(text, 'cancel') && BROWSER_CANCEL_QUALIFIERS.some(qualifier => hasWord(text, qualifier));
}

/**
 * Whether a click is a commit (Tier 3) or an explore (Tier 1): a form submit, or a commit word on
 * the element's accessible name. Links, tabs, menus and "show more" fall through as explore.
 */
export function classifyBrowserClickKind(input: {
  accessible_name: string;
  is_form_submit: boolean;
}): 'commit' | 'explore' {
  if (input.is_form_submit) {
    return 'commit';
  }
  return matchesCommitWord(input.accessible_name) ? 'commit' : 'explore';
}

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

function shown(text: string): string {
  return escapeDisplayText(text).replace(/"/g, '\\"');
}

/** The approval card for a commit click: the button's label, the site, and the form's values. */
function commitClickCard(review: BrowserClickReview): Tier3Card {
  const label = review.accessible_name.trim() === '' ? '(no label)' : shown(review.accessible_name);
  const outbound = renderOutboundArguments(review.form_values);
  return {
    plain_what: `Click "${label}" on ${shown(review.site)}?`,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: review.site,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: outbound.text,
    destination_host: review.site,
    outbound_truncated: outbound.truncated,
  };
}

/**
 * Tier rules for the browser's tools, in the shape of `classifyCaldavTool`. Returns undefined for
 * any other tool, and for a click the host could not read context for, so the generic path
 * classifies it (fail closed).
 */
export async function classifyBrowserTool({
  action,
  provenance,
  assistant,
  mintToken,
}: {
  action: Pick<SentinelAction, 'tool_name' | 'canonical_params' | 'tool_type' | 'browser_click'>;
  provenance: ChatProvenance;
  /** The assistant's display name, for the sentence that says why it is asking. */
  assistant: string;
  /** Mints the approval token over the given params; the caller hashes exactly what is passed. */
  mintToken: (params: unknown) => Promise<string>;
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
        approval_token_id: await mintToken(action.canonical_params),
      });
    }
    return tier1Decision({
      reason: BROWSER_EXPLORE_REASON,
      reason_detail: 'Reads or moves around in the browser. Nothing is submitted.',
      sensitive_read: false,
    });
  }
  if (action.tool_name === BROWSER_TYPE_TOOL_NAME || action.tool_name === BROWSER_SELECT_TOOL_NAME) {
    return tier1Decision({
      reason: BROWSER_PREPARE_REASON,
      reason_detail: 'Types into a field or picks an option. Nothing has left the computer yet.',
      sensitive_read: false,
    });
  }
  if (action.tool_name === BROWSER_CLICK_TOOL_NAME) {
    const review = action.browser_click;
    if (review === undefined) {
      return undefined;
    }
    const kind = classifyBrowserClickKind({
      accessible_name: review.accessible_name,
      is_form_submit: review.is_form_submit,
    });
    if (kind === 'explore') {
      return tier1Decision({
        reason: BROWSER_EXPLORE_REASON,
        reason_detail: 'Follows a link, opens a tab, or another click that submits nothing.',
        sensitive_read: false,
      });
    }
    return tier3Decision({
      card: commitClickCard(review),
      reason: BROWSER_COMMIT_REASON,
      reason_detail: review.is_form_submit
        ? 'Submits a form, so Aman always asks first.'
        : 'Its label is a word Aman always asks about first: a pay, buy, send, delete, cancel or similar action.',
      sensitive_read: false,
      // The ref alone is not what was approved: the token binds the ref together with the page's
      // own account of the click (site, label, form-submit-ness, form values), so BrowserTool's
      // liveMintParams, re-reading the live page at dispatch, catches it changing since approval.
      approval_token_id: await mintToken({ ref: action.canonical_params['ref'], review }),
    });
  }
  return tier1Decision({
    reason: BROWSER_EXPLORE_REASON,
    reason_detail: 'Reads or moves around in the browser. Nothing is submitted.',
    sensitive_read: false,
  });
}
