/**
 * Tier rules for Aman's own browser. Reading, scrolling, going back and taking a screenshot only
 * look at the page already open and never submit anything, so they run without asking (Tier 1), the
 * same way a mail read does. Typing into a field and picking an option ask first (Tier 3), with the
 * exact text on the card: a page's own script can send a field's value the moment it changes.
 *
 * Opening a page is different: the address itself goes to the site, so whatever is in it leaves
 * with the request. `browser_open` is classified in classifier.ts (`classifyBrowserOpen`) with the
 * same outbound checks a search provider's page read gets, and this module only supplies its card.
 *
 * A click is the one call that may submit something, and asks first (Tier 3) unless it is plainly
 * safe. A button, a menu item, a tab, or anything else that runs the page's own script may submit
 * whatever that script likes, whatever its label says and in whatever language, so every one of them
 * asks. Only a plain link to another page runs without asking (Tier 1): the browser opens its
 * address instead of clicking it, so no script of the page runs. Even a link asks when it submits a form or its label is a commit word (pay, buy, cancel
 * a membership, and so on). The word list only ever makes a click ask; it never lets one through.
 */
import { BrowserElementReviewSchema, type BrowserElementReview } from '../llm/LLMTypes';
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
import { browserCardCopy } from './cardCopy';
import type { SentinelAction } from './classifier';
import { escapeDisplayText } from './displayText';
import { renderOutboundArguments } from './extractorRegistry';
import { withHoldSay } from './searchHoldText';
import { autoDenyDecision, tier1Decision, tier3Decision, type Tier3Card, type TierDecision } from './tier';

/**
 * The card for an open that asks: the exact address, which is everything the open sends, and the site
 * it goes to. The question and the sentence that says why this open asks arrive apart, so the copy
 * owner can lead with the question and carry the sentence as the reason; plain_what joins them.
 */
export function browserOpenCard(input: {
  url: string;
  host: string | null;
  headline: string;
  say: string;
  plain_why: string | null;
}): Tier3Card {
  return {
    plain_what: withHoldSay(input.headline, input.say),
    copy: browserCardCopy({ headline: input.headline, reason: input.say }),
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
const BROWSER_COMMIT_PHRASES: readonly string[] = ['sign up', 'check out'];

/**
 * "Cancel" alone closes any ordinary dialog (a form's own Cancel button, a modal's close button) and
 * is not a commit word by itself; it is one only together with what it cancels, so "Cancel" on a
 * dialog never asks while "Cancel membership" always does.
 */
export const BROWSER_CANCEL_QUALIFIERS: readonly string[] = ['membership', 'subscription', 'plan', 'order', 'account'];

/**
 * A name as a person reads it: compatibility forms folded (a full-width letter reads as the letter),
 * characters that show nothing taken out (a zero-width space or a soft hyphen in the middle of "pay"
 * still reads as "pay"), lower case, and runs of spaces, hyphens and underscores as one space.
 */
function normalizedName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text);
}

function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`\\b${phrase}\\b`).test(text);
}

/** Whether an element's accessible name matches a commit word or phrase. */
export function matchesCommitWord(accessibleName: string): boolean {
  const text = normalizedName(accessibleName);
  if (BROWSER_COMMIT_WORDS.some(word => hasWord(text, word))) {
    return true;
  }
  if (BROWSER_COMMIT_PHRASES.some(phrase => hasPhrase(text, phrase))) {
    return true;
  }
  return hasWord(text, 'cancel') && BROWSER_CANCEL_QUALIFIERS.some(qualifier => hasWord(text, qualifier));
}

/** Why a click asks first, or that it does not: the one place the click rules are decided. */
export type BrowserClickKind = 'form_submit' | 'not_a_link' | 'commit_word' | 'explore';

/**
 * Whether a click asks first, and why. A form submit asks. Anything that is not a plain link asks,
 * because the page's own script decides what it does. A plain link asks when its label is a commit
 * word. Only a plain link with an ordinary label is an explore (Tier 1).
 */
export function classifyBrowserClickKind(
  review: Pick<BrowserElementReview, 'accessible_name' | 'is_form_submit' | 'link_url'>,
): BrowserClickKind {
  if (review.is_form_submit) {
    return 'form_submit';
  }
  if (review.link_url === null) {
    return 'not_a_link';
  }
  return matchesCommitWord(review.accessible_name) ? 'commit_word' : 'explore';
}

const COMMIT_REASON_DETAIL: Record<Exclude<BrowserClickKind, 'explore'>, string> = {
  form_submit: 'Submits a form, so Aman always asks first.',
  not_a_link:
    'A button or other control can send something to the site, whatever its label says, so Aman always asks first.',
  commit_word: 'Its label is a word Aman always asks about first: a pay, buy, send, delete, cancel or similar action.',
};

function shown(text: string): string {
  return escapeDisplayText(text).replace(/"/g, '\\"');
}

/** Longest page label or typed text a card's headline holds; the card's detail shows all of it. */
const HEADLINE_TEXT_MAX = 60;

/** `text` for a card headline: shown, and cut short with an ellipsis past the headline's room. */
function headlineText(text: string): string {
  const characters = Array.from(text);
  return characters.length <= HEADLINE_TEXT_MAX
    ? shown(text)
    : `${shown(characters.slice(0, HEADLINE_TEXT_MAX).join(''))}…`;
}

/** A page label for a card headline, or a plain stand-in when the element has none. */
function headlineLabel(label: string): string {
  return label.trim() === '' ? '(no label)' : headlineText(label);
}

/** The approval card for a commit click: the button's label, the site, and the form's values. */
function commitClickCard(review: BrowserElementReview): Tier3Card {
  const label = headlineLabel(review.accessible_name);
  const outbound = renderOutboundArguments(review.form_values);
  const plain_what = `Click "${label}" on ${shown(review.site)}?`;
  return {
    plain_what,
    copy: browserCardCopy({ headline: plain_what, reason: null }),
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

/** The card for typing or picking: the exact text, the field it goes into, and the site. */
function prepareCard(input: { review: BrowserElementReview; verb: 'Type' | 'Pick'; text: string }): Tier3Card {
  const field = headlineLabel(input.review.accessible_name);
  const outbound = renderOutboundArguments({ [input.review.accessible_name.trim() || 'field']: input.text });
  const plain_what = `${input.verb} "${headlineText(input.text)}" ${input.verb === 'Type' ? 'into' : 'in'} "${field}" on ${shown(input.review.site)}?`;
  return {
    plain_what,
    copy: browserCardCopy({ headline: plain_what, reason: null }),
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: input.review.site,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: outbound.text,
    destination_host: input.review.site,
    outbound_truncated: outbound.truncated,
  };
}

/** The `text` or `option` argument of a type or select call, or '' when it is missing. */
function preparedText(params: Record<string, unknown>, key: 'text' | 'option'): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
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

/** Why an action on a page element is refused before any card: the element could not be read first. */
const UNREAD_ELEMENT_DETAIL =
  'Aman could not read that part of the page first, so it was not touched. Read the page again, then try again.';

/**
 * Tier rules for the browser's tools that act on one element of the open page. Typing and picking an
 * option ask first, with the exact text on the card, because the page's own script may send a value
 * the moment it changes. A click asks first unless it is a plain link (see `classifyBrowserClickKind`).
 * An action whose element the host could not read is refused before any card, because it could never
 * run: the browser acts only on an element that still matches its read. Returns undefined for any
 * other tool, so the generic path classifies it (fail closed).
 */
export async function classifyBrowserActionTool({
  action,
  mintToken,
}: {
  action: Pick<SentinelAction, 'tool_name' | 'tool_type' | 'browser_element' | 'canonical_params'>;
  mintToken: () => Promise<string>;
}): Promise<TierDecision | undefined> {
  if (action.tool_type !== 'truefoundry-system' || !isBrowserToolName(action.tool_name)) {
    return undefined;
  }
  const acts =
    action.tool_name === BROWSER_TYPE_TOOL_NAME ||
    action.tool_name === BROWSER_SELECT_TOOL_NAME ||
    action.tool_name === BROWSER_CLICK_TOOL_NAME;
  if (!acts) {
    return undefined;
  }
  const review = action.browser_element;
  if (review === undefined) {
    return autoDenyDecision({
      reason: 'tool_not_prepared',
      reason_detail: UNREAD_ELEMENT_DETAIL,
      owner_message: UNREAD_ELEMENT_DETAIL,
      sensitive_read: false,
    });
  }
  if (action.tool_name !== BROWSER_CLICK_TOOL_NAME) {
    const typing = action.tool_name === BROWSER_TYPE_TOOL_NAME;
    return tier3Decision({
      card: prepareCard({
        review,
        verb: typing ? 'Type' : 'Pick',
        text: preparedText(action.canonical_params, typing ? 'text' : 'option'),
      }),
      reason: BROWSER_PREPARE_REASON,
      reason_detail: 'A page can send what is typed or picked the moment it changes, so Aman always asks first.',
      sensitive_read: false,
      approval_token_id: await mintToken(),
    });
  }
  const kind = classifyBrowserClickKind(review);
  if (kind === 'explore') {
    return tier1Decision({
      reason: BROWSER_EXPLORE_REASON,
      reason_detail: 'Opens the address of a plain link. Nothing is submitted.',
      sensitive_read: false,
    });
  }
  return tier3Decision({
    card: commitClickCard(review),
    reason: BROWSER_COMMIT_REASON,
    reason_detail: COMMIT_REASON_DETAIL[kind],
    sensitive_read: false,
    approval_token_id: await mintToken(),
  });
}

/** Every field of a read, taken from its schema so a field added there is always compared. */
const ELEMENT_REVIEW_FIELDS = BrowserElementReviewSchema.keyof().options;

function sameValues({ a, b }: { a: Record<string, string>; b: Record<string, string> }): boolean {
  const aNames = Object.keys(a).sort();
  const bNames = Object.keys(b).sort();
  return (
    aNames.length === bNames.length && aNames.every((name, index) => name === bNames[index] && a[name] === b[name])
  );
}

/**
 * True when two reads of the element a browser action acts on agree on every field: a held action
 * runs only while the live element still reads the way it did when the person was asked.
 */
export function sameBrowserElementReview({ a, b }: { a: BrowserElementReview; b: BrowserElementReview }): boolean {
  return ELEMENT_REVIEW_FIELDS.every(field =>
    field === 'form_values' ? sameValues({ a: a.form_values, b: b.form_values }) : a[field] === b[field],
  );
}
