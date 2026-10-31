/**
 * Tier rules for Aman's own browser. Reading, scrolling, going back and taking a screenshot only
 * look at the page already open and never submit anything, so they run without asking (Tier 1), the
 * same way a mail read does. Typing into a field and picking an option are Tier 1 too: nothing has
 * left the computer yet.
 *
 * Opening a page is different: the address itself goes to the site, so whatever is in it leaves
 * with the request. `browser_open` is classified in classifier.ts (`classifyBrowserOpen`) with the
 * same outbound checks a search provider's page read gets, and this module only supplies its card.
 *
 * A click is the one call that may submit something. It is Tier 3 (a card first) when it submits a
 * form, or when its accessible name matches a commit word (pay, buy, cancel a membership, and so
 * on); otherwise it is Tier 1, the same as following a link or opening a tab.
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
import { tier1Decision, tier3Decision, type Tier3Card, type TierDecision } from './tier';

/** The card for an open that asks: the exact address, which is everything the open sends. */
export function browserOpenCard(input: { url: string; plain_what: string; plain_why: string | null }): Tier3Card {
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
    destination_host: null,
    outbound_truncated: false,
  };
}

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

function shown(text: string): string {
  return escapeDisplayText(text).replace(/"/g, '\\"');
}

/** The approval card for a commit click: the button's label, the site, the form's values, and a picture of the page. */
function commitClickCard(review: BrowserClickReview, screenshot: string | undefined): Tier3Card {
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
    browser_screenshot: screenshot ?? null,
  };
}

/**
 * Tier rules for the browser's tools that only look at the open page. Returns undefined for
 * `browser_open` (classified on its own), for the tools that act on the page (classified by
 * `classifyBrowserActionTool`) and for any other tool, so the generic path classifies it
 * (fail closed).
 */
export function classifyBrowserViewTool(
  action: Pick<SentinelAction, 'tool_name' | 'tool_type'>,
): TierDecision | undefined {
  if (
    action.tool_type !== 'truefoundry-system' ||
    !isBrowserToolName(action.tool_name) ||
    action.tool_name === BROWSER_OPEN_TOOL_NAME ||
    action.tool_name === BROWSER_TYPE_TOOL_NAME ||
    action.tool_name === BROWSER_SELECT_TOOL_NAME ||
    action.tool_name === BROWSER_CLICK_TOOL_NAME
  ) {
    return undefined;
  }
  return tier1Decision({
    reason: BROWSER_EXPLORE_REASON,
    reason_detail: 'Reads or moves around in the open page. Nothing is submitted.',
    sensitive_read: false,
  });
}

/**
 * Tier rules for the browser's tools that act on the open page: typing and picking an option run
 * without asking, and a click asks first only when it is a commit. Returns undefined for any
 * other tool, and for a click the host could not read context for, so the generic path
 * classifies it (fail closed).
 */
export async function classifyBrowserActionTool({
  action,
  mintToken,
}: {
  action: Pick<
    SentinelAction,
    'tool_name' | 'canonical_params' | 'tool_type' | 'browser_click' | 'browser_click_screenshot'
  >;
  /** Mints the approval token over the given params; the caller hashes exactly what is passed. */
  mintToken: (params: unknown) => Promise<string>;
}): Promise<TierDecision | undefined> {
  if (action.tool_type !== 'truefoundry-system' || !isBrowserToolName(action.tool_name)) {
    return undefined;
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
      card: commitClickCard(review, action.browser_click_screenshot),
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
  return undefined;
}
