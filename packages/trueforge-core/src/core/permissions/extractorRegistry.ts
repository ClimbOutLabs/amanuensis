import { hasAnyHiddenCharacter, hasHiddenCharacters, replaceHiddenCharacters } from '../email/gmail/mimeText';

/**
 * Server-side extractor registry for Tier 3 approval cards.
 *
 * Destination, recipient, and amount are rendered from the canonical action
 * parameters through this registry, keyed by (tool name, args). They are never
 * taken from agent-supplied text. Every parameter capable of carrying a
 * destination, recipient, or amount must be covered: the generic extractor
 * scans fixed per-category key lists (including `cc`/`bcc` alongside `to`),
 * and adding a tool whose params use new key names requires extending those
 * lists, otherwise the fallback triggers.
 *
 * Fallback: for external-service actions (sending email or messages, posting
 * publicly, sharing data with external services, spending money) where the
 * destination cannot be determined server-side, the action is auto-denied with
 * reason `destination_unverifiable`, never carded. Other Tier 3 actions stay
 * Tier 3 with the destination marked unknown.
 */

import { createHash } from 'node:crypto';

export interface ExtractedCardFields {
  destination: string | null;
  recipient: string | null;
  amount: string | null;
  /** The call's exact arguments as "name: value" lines; only for connector (MCP) calls. */
  outbound_text: string | null;
  /** Host of the connector server that receives the call; only for connector (MCP) calls. */
  destination_host: string | null;
  /** True when part of outbound_text was cut and is not shown in full. */
  outbound_truncated: boolean;
}

export type CardFieldExtractor = (params: Record<string, unknown>) => ExtractedCardFields;

/** Keys that set a forwarding address; also recipient keys. */
const FORWARD_KEYS = ['forward', 'forward_to'];

/** Param keys that can carry a recipient. `to` alone is never enough. */
const RECIPIENT_KEYS = [
  'to',
  'recipient',
  'recipients',
  'cc',
  'bcc',
  'address',
  'email',
  'email_address',
  'phone',
  'phone_number',
  'handle',
  'username',
  'user',
  'user_id',
  'contact',
  'attendees',
  'invitees',
  'share_with',
  'members',
  'emails',
  'webhook_url',
  'reply_to',
  'from',
  'sender',
  ...FORWARD_KEYS,
  'to_recipients',
  'participants',
];

/** Field names that hold the address inside an object recipient such as `{ email, name }`. */
const ADDRESS_FIELD_KEYS = ['email', 'address', 'email_address', 'mail'];

/** Param keys that can carry a destination. */
const DESTINATION_KEYS = [
  'url',
  'link',
  'href',
  'endpoint',
  'webhook',
  'webhook_url',
  'service',
  'service_name',
  'destination',
  'target',
  'target_url',
  'repo',
  'repository',
  'channel',
  'channel_id',
  'chat_id',
  'thread',
  'site',
];

/** Param keys that can carry an amount. */
const AMOUNT_KEYS = ['amount', 'price', 'cost', 'total', 'value', 'sum', 'quantity'];

/** Lower-cased key without separators, so `emailAddress` and `email_address` compare equal. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const RECIPIENT_KEY_SET = new Set(RECIPIENT_KEYS.map(normalizeKey));
const ADDRESS_FIELD_SET = new Set(ADDRESS_FIELD_KEYS.map(normalizeKey));

function isRecipientKey(key: string): boolean {
  return RECIPIENT_KEY_SET.has(normalizeKey(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeToken(char: string): string {
  return `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`;
}

/** Tab and carriage return, which a card never shows raw, and lone surrogates; newlines too unless they are kept. */
const REMAINING_ESCAPES = /\p{Cc}|\p{Surrogate}/gu;
const REMAINING_ESCAPES_KEEPING_NEWLINES = /(?!\n)\p{Cc}|\p{Surrogate}/gu;

/**
 * Makes model-controlled text safe to show: characters that can hide or fake text become visible
 * `\u{XXXX}` tokens. Display only; nothing that is sent or hashed passes through here. Newlines are
 * kept only when asked, and CRLF counts as one.
 */
export function escapeDisplayText(text: string, options?: { keepNewlines?: boolean }): string {
  const keepNewlines = options?.keepNewlines === true;
  // The one definition of "does not show" decides first; the pass below adds what a card never shows raw.
  const visible = replaceHiddenCharacters(keepNewlines ? text.replace(/\r\n/g, '\n') : text, escapeToken);
  return visible.replace(keepNewlines ? REMAINING_ESCAPES_KEEPING_NEWLINES : REMAINING_ESCAPES, escapeToken);
}

function clean(text: string): string {
  return escapeDisplayText(text.trim());
}

/** Every recipient in one value: strings, arrays of strings, and objects reduced to their address field. */
function recipientItems(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.trim() === '' ? [] : [clean(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(recipientItems);
  }
  if (isRecord(value)) {
    const addresses = Object.entries(value)
      .filter(([key, field]) => ADDRESS_FIELD_SET.has(normalizeKey(key)) && typeof field === 'string')
      .flatMap(([, field]) => recipientItems(field));
    // An object with no address field still shows what it holds rather than hiding it.
    return addresses.length > 0 ? addresses : [clean(argumentJson(value))];
  }
  return [];
}

/** Recipients under the top-level recipient keys, in argument order, without duplicates. */
function recipientValues(params: Record<string, unknown>): string[] {
  const out = Object.entries(params)
    .filter(([key]) => isRecipientKey(key))
    .flatMap(([, value]) => recipientItems(value));
  return [...new Set(out)];
}

const NESTED_RECIPIENT_MAX_DEPTH = 4;

/** Recipients at any depth under the given normalized keys, so one tucked inside a nested argument still reaches the card. */
function nestedRecipientValues(value: unknown, keys: Set<string> = RECIPIENT_KEY_SET, depth = 0): string[] {
  if (Array.isArray(value)) {
    return depth > NESTED_RECIPIENT_MAX_DEPTH
      ? []
      : value.flatMap(item => nestedRecipientValues(item, keys, depth + 1));
  }
  if (!isRecord(value) || depth > NESTED_RECIPIENT_MAX_DEPTH) {
    return [];
  }
  return Object.entries(value).flatMap(([key, field]) =>
    keys.has(normalizeKey(key)) ? recipientItems(field) : nestedRecipientValues(field, keys, depth + 1),
  );
}

function stringValues(params: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '') {
      out.push(clean(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') {
          out.push(clean(item));
        }
      }
    }
  }
  return [...new Set(out)];
}

function joinOrNull(values: string[]): string | null {
  return values.length === 0 ? null : values.join(', ');
}

function firstOrNull(values: string[]): string | null {
  const first = values[0];
  return first ?? null;
}

/**
 * Generic extractor: covers every param key in the per-category lists. Tool
 * specific entries below refine it; the key lists are the contract.
 */
export function genericExtractor(params: Record<string, unknown>): ExtractedCardFields {
  return {
    destination: firstOrNull(stringValues(params, DESTINATION_KEYS)),
    recipient: joinOrNull(recipientValues(params)),
    amount: firstOrNull(stringValues(params, AMOUNT_KEYS)),
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
  };
}

/** Longest value shown in full; a longer one is cut with a marker. Recipient values are never cut. */
export const OUTBOUND_VALUE_MAX_CHARS = 2000;
/** Longest value of a send shown in full; a send with a longer one is refused instead of cut. */
export const SEND_VALUE_MAX_CHARS = 20_000;
/** Longest outbound_text before every non-recipient value is cut harder; keys and recipients always stay. */
export const OUTBOUND_TEXT_MAX_CHARS = 100_000;
const OUTBOUND_REDUCED_VALUE_MAX_CHARS = 100;
const OUTBOUND_KEY_MAX_CHARS = 200;
const OUTBOUND_GUTTER = '  | ';
const PLAIN_KEY = /^[A-Za-z0-9_.-]+$/;

function argumentJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Shown after the key for anything that is not a string, so `5` and `"5"` never look alike. */
function typeHint(value: unknown): string | null {
  if (typeof value === 'string') {
    return null;
  }
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

function leadingCodePoints(text: string, count: number): { head: string; rest: number } {
  const points = Array.from(text);
  return { head: points.slice(0, count).join(''), rest: Math.max(0, points.length - count) };
}

function keyDisplay(key: string): { text: string; cut: boolean } {
  const { head, rest } = leadingCodePoints(key, OUTBOUND_KEY_MAX_CHARS);
  const shown = `${head}${rest > 0 ? '...' : ''}`;
  // A key that is not plain is quoted, so it can never pass for a gutter or a separate line.
  const text = PLAIN_KEY.test(shown) ? shown : `"${escapeDisplayText(shown).replace(/"/g, '\\"')}"`;
  return { text, cut: rest > 0 };
}

const DATA_URL = /^data:([^;,]*)[^,]*;base64,/;
const ATTACHMENT_KEY_SET = new Set(
  ['attachment', 'attachments', 'file_attachment', 'file_attachments'].map(normalizeKey),
);
const FILE_DATA_KEY_SET = new Set(
  ['content', 'data', 'bytes', 'content_bytes', 'file_data', 'base64', 'raw'].map(normalizeKey),
);
const ATTACHMENT_MAX_DEPTH = 6;
/** Longest attachment text shown on the card; a longer file is summarised like binary data. */
const FILE_TEXT_MAX_CHARS = 5000;
/** Shorter unprefixed strings are more likely plain words than encoded data. */
const MIN_ENCODED_CHARS = 16;

/** The text in these bytes, or null when they are not UTF-8 text (control characters other than tab and newlines mark binary). */
function decodeText(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Array.from(text).some(char => {
      const code = char.charCodeAt(0);
      return code <= 8 || (code >= 0x0e && code <= 0x1f);
    })
      ? null
      : text;
  } catch {
    return null;
  }
}

function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} bytes` : `about ${String(Math.round(bytes / 1024))} KB`;
}

/**
 * File data under an attachment: base64 (standard or URL-safe, padded or not) is decoded and short text is
 * shown; longer text and binary become one line with type, size and a fingerprint of the bytes.
 * Anything that is not valid base64 is returned unchanged.
 */
function decodeFileData(value: string): string {
  const prefixed = DATA_URL.test(value);
  const mime = DATA_URL.exec(value)?.[1] ?? '';
  const body = value
    .replace(DATA_URL, '')
    .replace(/[\r\n]/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  if ((!prefixed && body.length < MIN_ENCODED_CHARS) || !/^[A-Za-z0-9+/]+$/.test(body)) {
    return value;
  }
  const bytes = Buffer.from(body, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== body) {
    return value;
  }
  const text = decodeText(bytes);
  if (text !== null && text.length <= FILE_TEXT_MAX_CHARS) {
    return text;
  }
  const fingerprint = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return `(${text === null ? 'file data' : 'text file'}, ${mime === '' ? '' : `${mime}, `}${sizeLabel(bytes.length)}, fingerprint ${fingerprint})`;
}

/**
 * File data is bound into the approval but shown on the card as text or a one-line summary, so a large
 * attachment never counts against the length a send may have. Attachment keys are found at any depth.
 */
function summarizeAttachments(value: unknown, inAttachment = false, depth = 0): unknown {
  if (depth > ATTACHMENT_MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => summarizeAttachments(item, inAttachment, depth + 1));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      inAttachment && FILE_DATA_KEY_SET.has(normalizeKey(key)) && typeof field === 'string'
        ? decodeFileData(field)
        : summarizeAttachments(field, inAttachment || ATTACHMENT_KEY_SET.has(normalizeKey(key)), depth + 1),
    ]),
  );
}

function renderOutboundLines(
  params: Record<string, unknown>,
  valueMaxChars: number,
): { lines: string[]; truncated: boolean } {
  let truncated = false;
  const lines = Object.entries(params).map(([key, value]) => {
    const shownValue = summarizeAttachments(value, ATTACHMENT_KEY_SET.has(normalizeKey(key)));
    const raw = typeof shownValue === 'string' ? shownValue : argumentJson(shownValue);
    const { head, rest } = isRecipientKey(key) ? { head: raw, rest: 0 } : leadingCodePoints(raw, valueMaxChars);
    truncated ||= rest > 0;
    const shown = escapeDisplayText(head, { keepNewlines: true });
    const marker = rest > 0 ? ` ... (${String(rest)} more characters not shown)` : '';
    // Continuation lines carry a fixed gutter, so a value can never begin a line that reads like `key: value`.
    const [first = '', ...more] = `${shown}${marker}`.split('\n');
    const hint = typeHint(value);
    const keyShown = keyDisplay(key);
    truncated ||= keyShown.cut;
    const label = `${keyShown.text}${hint === null ? '' : ` (${hint})`}`;
    return [`${label}: ${first}`, ...more.map(line => `${OUTBOUND_GUTTER}${line}`)].join('\n');
  });
  return { lines, truncated };
}

/**
 * Every argument the connector will receive, one line each, built from the server's canonical params
 * so a model-written description can never stand in for what is sent. Every key is always listed
 * and recipient values are never cut; other values and over-long keys are capped, and `truncated` says whether any was.
 */
export function renderOutboundArguments(
  params: Record<string, unknown>,
  options?: { valueMaxChars?: number },
): { text: string | null; truncated: boolean } {
  if (Object.keys(params).length === 0) {
    return { text: null, truncated: false };
  }
  let rendered = renderOutboundLines(params, options?.valueMaxChars ?? OUTBOUND_VALUE_MAX_CHARS);
  let text = rendered.lines.join('\n');
  if (text.length > OUTBOUND_TEXT_MAX_CHARS) {
    rendered = renderOutboundLines(params, OUTBOUND_REDUCED_VALUE_MAX_CHARS);
    text = rendered.lines.join('\n');
  }
  return { text, truncated: rendered.truncated };
}

/** Host (with any port) of an http(s) URL, or null when the value is not one. */
export function hostFromUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host !== '' ? url.host : null;
  } catch {
    return null;
  }
}

interface ExtractorEntry {
  match: (toolName: string) => boolean;
  extract: CardFieldExtractor;
  external_service: boolean;
  /** Delivers a message to a person, so every part of its arguments must be fully visible. */
  delivers_message: boolean;
}

function nameIncludes(...fragments: string[]): (toolName: string) => boolean {
  const lowered = fragments.map(f => f.toLowerCase());
  return (toolName: string) => {
    const name = toolName.toLowerCase();
    return lowered.some(f => name.includes(f));
  };
}

/**
 * Registry entries, checked in order. `external_service` marks actions where
 * an unverifiable destination auto-denies instead of carding.
 */
const EXTRACTOR_REGISTRY: ExtractorEntry[] = [
  {
    match: nameIncludes('send_email', 'sendemail', 'email_send', 'emails_send'),
    extract: genericExtractor,
    external_service: true,
    delivers_message: true,
  },
  {
    match: nameIncludes('send_message', 'sendmessage', 'message_send', 'messages_send', 'send_sms', 'sendsms'),
    extract: genericExtractor,
    external_service: true,
    delivers_message: true,
  },
  {
    match: nameIncludes('post_message', 'publish_post', 'create_post', 'post_tweet', 'share_post'),
    extract: genericExtractor,
    external_service: true,
    delivers_message: false,
  },
  {
    match: nameIncludes('payment', 'pay_invoice', 'spend', 'transfer_funds', 'charge_card', 'create_charge'),
    extract: genericExtractor,
    external_service: true,
    delivers_message: false,
  },
  {
    match: nameIncludes('share', 'webhook'),
    extract: genericExtractor,
    external_service: true,
    delivers_message: false,
  },
  {
    // Without this entry the word `email` in the name would make an archive an external send with no destination.
    match: nameIncludes('archive_email'),
    extract: genericExtractor,
    external_service: false,
    delivers_message: false,
  },
];

/**
 * Lower-cased words of a tool name, joined by underscores and bounded by them, so a phrase
 * matches whole words only: `web_search_exa` has `search`, `research` does not.
 */
function nameWords(toolName: string): string {
  const words = toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word !== '');
  return `_${words.join('_')}_`;
}

function hasPhrase(words: string, ...phrases: string[]): boolean {
  return phrases.some(phrase => words.includes(`_${phrase}_`));
}

interface ConnectorCallInput {
  tool_name: string;
  words: string;
  /** " on <connector>" when the connector's configured name is known. */
  where: string;
  fields: ExtractedCardFields;
  params: Record<string, unknown>;
}

interface ConnectorFamily {
  match: (words: string, params: Record<string, unknown>) => boolean;
  describe: (input: ConnectorCallInput) => string;
  /**
   * The call sends data out and is never trusted by a hint or grant. A `message` sends or stages a
   * message to a person, so it also has to be shown in full and carry no hidden characters.
   */
  sends?: 'message' | 'content';
  /** The card has to name a recipient. */
  needs_recipient?: boolean;
  /** Replaces the recipient when only some addresses in the params receive anything, such as a filter's sender match. */
  recipient?: (params: Record<string, unknown>) => string | null;
  /** Replaces the destination when the params name a more precise one. */
  destination?: (params: Record<string, unknown>) => string | null;
}

const FORWARD_KEY_SET = new Set(FORWARD_KEYS.map(normalizeKey));

/** True when any argument, at any depth, sets a forwarding address. */
function hasForwardAction(params: Record<string, unknown>): boolean {
  return someArgument(
    params,
    (key, field) => FORWARD_KEY_SET.has(key) && typeof field === 'string' && field.trim() !== '',
  );
}

function repositoryLabel(params: Record<string, unknown>): string | null {
  const owner = firstOrNull(stringValues(params, ['owner']));
  const repo = firstOrNull(stringValues(params, ['repo', 'repository', 'repository_name']));
  if (repo === null) {
    return null;
  }
  return owner === null ? repo : `${owner}/${repo}`;
}

function toRecipient(fields: ExtractedCardFields): string {
  return fields.recipient === null ? '' : ` to ${fields.recipient}`;
}

const DESTRUCTIVE_AND_INSTALL_WORDS = ['delete', 'remove', 'uninstall', 'drop', 'destroy', 'erase', 'install'];

/** The first word of a connector call that only reads. */
const CONNECTOR_READ_VERBS = ['list', 'get', 'search', 'read', 'count', 'fetch', 'find', 'show', 'view'];
/**
 * Every word a connector read name may carry. A name with any other word is not a read, so it keeps the
 * decision it had before reads were recognized. A deny-list of send words can never be complete.
 */
const CONNECTOR_READ_WORDS = new Set([
  ...CONNECTOR_READ_VERBS,
  'message',
  'messages',
  'mail',
  'mails',
  'email',
  'emails',
  'thread',
  'threads',
  'unread',
  'attachment',
  'attachments',
  'inbox',
  'mailbox',
  'mailboxes',
  'header',
  'headers',
  'body',
  'content',
  'metadata',
  'folder',
  'folders',
  'by',
  'id',
]);

/**
 * Connector actions that are not external-service by name but still send data out. They only
 * change the card's wording and destination: tiers, auto-deny and offline handling come from
 * the registry above. Checked in order.
 */
const CONNECTOR_FAMILIES: ConnectorFamily[] = [
  {
    match: words => hasPhrase(words, 'gist'),
    sends: 'content',
    describe: ({ tool_name, where }) => `Publish a gist with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'push_files', 'create_or_update_file', 'create_repository'),
    sends: 'content',
    describe: ({ tool_name, where, params }) => {
      const repo = repositoryLabel(params);
      return `Write to ${repo === null ? 'a repository' : `repository ${repo}`} with ${tool_name}${where}.`;
    },
    destination: repositoryLabel,
  },
  {
    match: (words, params) => hasPhrase(words, 'create_filter') && hasForwardAction(params),
    sends: 'message',
    needs_recipient: true,
    recipient: params => joinOrNull([...new Set(nestedRecipientValues(params, FORWARD_KEY_SET))]),
    describe: ({ tool_name, where, fields }) =>
      `Forward every matching message${toRecipient(fields)}, now and from here on, with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'forward'),
    sends: 'message',
    describe: ({ tool_name, where, fields }) => `Forward a message${toRecipient(fields)} with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'reply'),
    sends: 'message',
    describe: ({ tool_name, where, fields }) => `Send a reply${toRecipient(fields)} with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'create_draft', 'draft_email', 'update_draft', 'gmail_draft', 'save_draft'),
    sends: 'message',
    describe: ({ tool_name, where, fields }) => `Save a message draft${toRecipient(fields)} with ${tool_name}${where}.`,
  },
  {
    // Archiving only moves mail inside the mailbox, so it carries no recipient and is not an external send.
    match: words => hasPhrase(words, 'archive'),
    describe: ({ tool_name, where }) => `Archive emails with ${tool_name}${where}.`,
  },
  {
    match: words =>
      hasPhrase(
        words,
        'web_fetch',
        'fetch_url',
        'fetch_page',
        'webfetch',
        'http_get',
        'get_url',
        'scrape',
        'crawl',
        'crawling',
        'tavily_extract',
        'extract_url',
      ),
    describe: ({ tool_name, where }) => `Fetch a web page with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'search'),
    describe: ({ tool_name, where, words }) =>
      `${hasPhrase(words, 'web', 'tavily', 'exa', 'engine') ? 'Search the web' : 'Run a search'} with ${tool_name}${where}.`,
  },
];

/** Tool-name fragments treated as external-service actions when unlisted. */
const EXTERNAL_SERVICE_FRAGMENTS = [
  'email',
  'mail',
  'sms',
  'message',
  'post',
  'publish',
  'tweet',
  'share',
  'payment',
  'pay',
  'spend',
  'transfer',
  'charge',
  'invoice',
  'webhook',
  'notify',
];

export interface ExtractionResult {
  fields: ExtractedCardFields;
  /** True when the fallback fired: external-service action, no verifiable destination. */
  destination_unverifiable: boolean;
  external_service: boolean;
  /** A connector call that only reads (see isConnectorRead): never a send, and never an unverifiable destination. */
  connector_read: boolean;
  /** Plain-words description of a known connector action (search, fetch, repo write, mail), or null. */
  connector_what: string | null;
  /** The call sends data out (a send family, an external service, or a named recipient); it is never trusted by a hint or grant. */
  sends: boolean;
  /** Why a send cannot be shown to the user in full, or null. Such a send is refused, never carded. */
  incomplete_send: IncompleteSend | null;
}

/** True when any argument, at any depth, passes `test`, given its normalized key and value. */
function someArgument(value: unknown, test: (key: string, field: unknown) => boolean, depth = 0): boolean {
  if (Array.isArray(value)) {
    return depth <= NESTED_RECIPIENT_MAX_DEPTH && value.some(item => someArgument(item, test, depth + 1));
  }
  if (!isRecord(value) || depth > NESTED_RECIPIENT_MAX_DEPTH) {
    return false;
  }
  return Object.entries(value).some(
    ([key, field]) => test(normalizeKey(key), field) || someArgument(field, test, depth + 1),
  );
}

/**
 * Sends whose recipients or text are filled in after approval, so no card can show them: replying to
 * everyone, and sending a saved draft. One list each; names, argument keys and string values all use it.
 */
const REPLY_ALL_PHRASES = ['reply_all', 'reply_to_all', 'respond_all', 'respond_to_all'];
const REPLY_ALL_SET = new Set(REPLY_ALL_PHRASES.map(normalizeKey));
const DRAFT_SEND_PHRASES = ['send_draft'];
const DRAFT_VALUE_SET = new Set([...DRAFT_SEND_PHRASES, 'draft'].map(normalizeKey));
const OFF_VALUES = new Set(['', 'false', '0', 'no', 'n', 'off', 'none', 'null']);

/** Under a reply-all or draft key, anything that is not clearly off counts as on. */
function isOff(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) {
    return true;
  }
  return typeof value === 'string' && OFF_VALUES.has(value.trim().toLowerCase());
}

function namesPhrase({ key, field, set }: { key: string; field: unknown; set: Set<string> }): boolean {
  return (set.has(key) && !isOff(field)) || (typeof field === 'string' && set.has(normalizeKey(field)));
}

type HiddenSend = 'reply_all' | 'draft';

/** Which hidden send the call is, read from its name and any argument at any depth. */
function hiddenSendKind({
  tool_name,
  words,
  params,
}: {
  tool_name: string;
  words: string;
  params: Record<string, unknown>;
}): HiddenSend | null {
  const nameKey = normalizeKey(tool_name);
  if (
    hasPhrase(words, ...REPLY_ALL_PHRASES) ||
    REPLY_ALL_SET.has(nameKey) ||
    someArgument(params, (key, field) => namesPhrase({ key, field, set: REPLY_ALL_SET }))
  ) {
    return 'reply_all';
  }
  // A plain `draft` flag (a draft pull request) is state, not a reference to a stored draft.
  const isStateFlag = (key: string, field: unknown) =>
    typeof field === 'boolean' && (key === 'draft' || key === 'isdraft');
  if (
    hasPhrase(words, ...DRAFT_SEND_PHRASES) ||
    nameKey === 'senddraft' ||
    someArgument(
      params,
      (key, field) =>
        !isStateFlag(key, field) &&
        ((key.includes('draft') && !isOff(field)) ||
          (typeof field === 'string' && DRAFT_VALUE_SET.has(normalizeKey(field)))),
    )
  ) {
    return 'draft';
  }
  return null;
}

/**
 * A connector call that only reads: every word of its name is a read word, and the first is a read verb. It
 * also has no recipient or hidden send in its arguments. Its annotations still decide how it is approved;
 * they never make it a send.
 */
function isConnectorRead({
  tool_name,
  words,
  params,
}: {
  tool_name: string;
  words: string;
  params: Record<string, unknown>;
}): boolean {
  // Only plain ASCII names count: a lookalike or hidden character splits words and could hide a send.
  if (!/^[A-Za-z0-9._ -]+$/.test(tool_name)) {
    return false;
  }
  const nameWordList = words.split('_').filter(word => word !== '');
  const firstWord = nameWordList[0];
  return (
    firstWord !== undefined &&
    CONNECTOR_READ_VERBS.includes(firstWord) &&
    nameWordList.every(word => CONNECTOR_READ_WORDS.has(word)) &&
    nestedRecipientValues(params).length === 0 &&
    hiddenSendKind({ tool_name, words, params }) === null
  );
}

/** True when nothing in the text would show: only whitespace and hidden characters. */
function isBlank(text: string): boolean {
  return Array.from(text).every(char => /\s/u.test(char) || hasAnyHiddenCharacter(char));
}

function addressStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return isBlank(value) ? [] : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(addressStrings);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([key]) => ADDRESS_FIELD_SET.has(normalizeKey(key)))
    .flatMap(([, field]) => addressStrings(field));
}

/** True when the top-level `to` or `recipients` resolves to at least one visible address. */
function namesToRecipient(params: Record<string, unknown>): boolean {
  return Object.entries(params).some(
    ([key, value]) => ['to', 'recipients'].includes(normalizeKey(key)) && addressStrings(value).length > 0,
  );
}

const REPLY_WORDS = ['reply', 'respond', 'answer', 'forward'];
const MAIL_WORDS = ['mail', 'email', 'gmail', 'outlook', 'inbox'];

/**
 * A reply or forward through a mail connector goes to its default recipients when no recipient is named, so
 * `to` or `recipients` must name them. Other reply tools (comments, threads in chat apps) have neither and are
 * not mail-shaped.
 */
function isMailReply({ words, params }: { words: string; params: Record<string, unknown> }): boolean {
  return (
    hasPhrase(words, ...REPLY_WORDS) &&
    (hasPhrase(words, ...MAIL_WORDS) ||
      Object.keys(params).some(key => ['to', 'recipients', 'cc', 'bcc'].includes(normalizeKey(key))))
  );
}

interface IncompleteSend {
  /** What the model is told: the one thing to do. */
  model_message: string;
  /** One short plain line for the owner, shown without the agent details. */
  owner_message: string;
}

const REFUSALS: Record<HiddenSend | 'hidden_characters' | 'long_key' | 'too_long' | 'no_recipient', IncompleteSend> = {
  reply_all: {
    model_message:
      'Replying to everyone fills in the recipients after approval, so it cannot be shown. Reply on the same message with every person who should get it named in `to`.',
    owner_message:
      'Nothing was sent: replying to everyone would not show you who gets it. The assistant needs to name each person.',
  },
  draft: {
    model_message:
      'A saved draft is sent with recipients and text that are filled in after approval, so it cannot be shown. Write the message out in full with every recipient named in `to`.',
    owner_message:
      'Nothing was sent: a saved draft hides who gets it and what it says. The assistant must write it out in full.',
  },
  hidden_characters: {
    model_message:
      'This contains hidden characters that would not show on the approval card, so it cannot be approved. Remove them and try again.',
    owner_message:
      'Nothing was sent: it contains hidden characters you could not see. The assistant needs to remove them.',
  },
  long_key: {
    model_message:
      'An argument name is too long to show in full, so this cannot be approved. Use shorter argument names.',
    owner_message:
      'Nothing was sent: a field name was too long to show you in full. The assistant needs to shorten it.',
  },
  too_long: {
    model_message:
      'This is too long to show in full, so it cannot be approved. Shorten it or split it into smaller messages.',
    owner_message: 'Nothing was sent: it is too long to show you in full. The assistant needs to shorten it.',
  },
  no_recipient: {
    model_message: 'This does not name who receives it. Name each recipient in `to` and try again.',
    owner_message: 'Nothing was sent: it did not say who gets it. The assistant needs to name each person.',
  },
};

/** True when any string value passes `test` or any key holds a hidden character, at any depth. */
function containsHidden(value: unknown, test: (text: string) => boolean): boolean {
  if (typeof value === 'string') {
    return test(value);
  }
  if (Array.isArray(value)) {
    return value.some(item => containsHidden(item, test));
  }
  // Keys always take the strict check: a field name never needs an emoji or script joiner.
  return (
    isRecord(value) &&
    Object.entries(value).some(([key, field]) => hasAnyHiddenCharacter(key) || containsHidden(field, test))
  );
}

/** True when a recipient value, at any depth, holds a hidden character; recipients never get an allowance. */
function hasHiddenRecipient(params: Record<string, unknown>): boolean {
  return someArgument(
    params,
    (key, field) => RECIPIENT_KEY_SET.has(key) && containsHidden(field, hasAnyHiddenCharacter),
  );
}

/** Message text gets the writing allowances; attachment text is checked as decoded, since that is what is received. */
function hasHiddenMessageText(params: Record<string, unknown>): boolean {
  return (
    containsHidden(params, hasHiddenCharacters) || containsHidden(summarizeAttachments(params), hasHiddenCharacters)
  );
}

/**
 * Why a send cannot be shown to the owner in full, or null. The reply-to-everyone and saved-draft rule
 * holds for every tool that is not declared read-only and closed-world, whatever it is called. A message
 * to a person is refused on any hidden character outside a well-formed emoji or script sequence; other
 * sends only on a hidden recipient, since the card shows other hidden text as codes.
 */
function incompleteSend(input: {
  hidden: HiddenSend | null;
  sends: boolean;
  delivers_message: boolean;
  /** The card lists every argument, so a key it would cut hides part of the send. */
  shows_arguments: boolean;
  message_send: boolean;
  truncated: boolean;
  needs_recipient: boolean;
  needs_to: boolean;
  params: Record<string, unknown>;
  fields: ExtractedCardFields;
}): IncompleteSend | null {
  if (input.hidden !== null) {
    return REFUSALS[input.hidden];
  }
  if (
    input.sends &&
    (hasHiddenRecipient(input.params) || (input.delivers_message && hasHiddenMessageText(input.params)))
  ) {
    return REFUSALS.hidden_characters;
  }
  if (
    input.sends &&
    input.shows_arguments &&
    Object.keys(input.params).some(key => leadingCodePoints(key, OUTBOUND_KEY_MAX_CHARS).rest > 0)
  ) {
    return REFUSALS.long_key;
  }
  if (input.message_send && input.truncated) {
    return REFUSALS.too_long;
  }
  if (
    (input.needs_recipient && input.fields.recipient === null) ||
    (input.needs_to && !namesToRecipient(input.params))
  ) {
    return REFUSALS.no_recipient;
  }
  return null;
}

/**
 * Extract card fields for a Tier 3 action. Never reads agent text: only the
 * canonical params the server parsed. For a connector (MCP) call the exact
 * arguments and the connector server's host are attached so the user sees what leaves.
 */
export function extractCardFields(input: {
  tool_name: string;
  canonical_params: Record<string, unknown>;
  tool_type?: 'truefoundry-system' | 'mcp' | undefined;
  /** Host of the connector's configured server URL. */
  server_host?: string | undefined;
  /** The connector's configured name. */
  server_name?: string | undefined;
  /** The tool is declared read-only and closed-world: a recipient or draft argument alone does not make it a send. */
  read_only_closed_world?: boolean | undefined;
}): ExtractionResult {
  const entry = EXTRACTOR_REGISTRY.find(e => e.match(input.tool_name));
  const externalService =
    entry?.external_service ?? EXTERNAL_SERVICE_FRAGMENTS.some(f => input.tool_name.toLowerCase().includes(f));
  const base = entry !== undefined ? entry.extract(input.canonical_params) : genericExtractor(input.canonical_params);
  const destinationUnverifiable = externalService && base.destination === null && base.recipient === null;
  if (input.tool_type !== 'mcp') {
    return {
      fields: base,
      destination_unverifiable: destinationUnverifiable,
      external_service: externalService,
      connector_read: false,
      connector_what: null,
      sends: externalService,
      incomplete_send: incompleteSend({
        hidden: null,
        sends: externalService,
        delivers_message: entry?.delivers_message === true,
        shows_arguments: false,
        message_send: false,
        truncated: false,
        needs_recipient: false,
        needs_to: false,
        params: input.canonical_params,
        fields: base,
      }),
    };
  }
  const readOnly = input.read_only_closed_world === true;
  const words = nameWords(input.tool_name);
  // Deleting or installing is described by the classifier's own destructive and install cards.
  const family = hasPhrase(words, ...DESTRUCTIVE_AND_INSTALL_WORDS)
    ? undefined
    : CONNECTOR_FAMILIES.find(f => f.match(words, input.canonical_params));
  const connectorRead =
    family?.sends === undefined &&
    isConnectorRead({ tool_name: input.tool_name, words, params: input.canonical_params });
  const where =
    input.server_name === undefined || input.server_name === '' ? '' : ` on ${escapeDisplayText(input.server_name)}`;
  const recipients = [...new Set(nestedRecipientValues(input.canonical_params))];
  const hidden = readOnly
    ? null
    : hiddenSendKind({ tool_name: input.tool_name, words, params: input.canonical_params });
  const sends =
    (externalService && !connectorRead) ||
    family?.sends !== undefined ||
    hidden !== null ||
    (readOnly ? hasPhrase(words, 'send') : recipients.length > 0);
  // Repository writes and gists keep the cut preview; their arguments are still bound into the approval.
  const messageSend = sends && family?.sends !== 'content';
  const outbound = renderOutboundArguments(input.canonical_params, {
    valueMaxChars: messageSend ? SEND_VALUE_MAX_CHARS : OUTBOUND_VALUE_MAX_CHARS,
  });
  const fields: ExtractedCardFields = {
    ...base,
    destination: family?.destination?.(input.canonical_params) ?? base.destination,
    // Includes recipients nested inside other arguments; the unverifiable check above stays top-level.
    recipient: family?.recipient === undefined ? joinOrNull(recipients) : family.recipient(input.canonical_params),
    outbound_text: outbound.text,
    outbound_truncated: outbound.truncated,
    // Only the connector's own configured URL: a host read from the arguments is the model's claim.
    destination_host: input.server_host === undefined ? null : escapeDisplayText(input.server_host),
  };
  return {
    fields,
    destination_unverifiable: destinationUnverifiable && !connectorRead,
    external_service: externalService,
    connector_read: connectorRead,
    sends,
    incomplete_send: incompleteSend({
      hidden,
      sends,
      delivers_message: entry?.delivers_message === true || family?.sends === 'message',
      shows_arguments: true,
      message_send: messageSend,
      truncated: outbound.truncated,
      needs_recipient: family?.needs_recipient === true,
      needs_to: isMailReply({ words: `${words}${nameWords(input.server_name ?? '')}`, params: input.canonical_params }),
      params: input.canonical_params,
      fields,
    }),
    connector_what:
      family === undefined
        ? null
        : family.describe({
            tool_name: escapeDisplayText(input.tool_name),
            words,
            where,
            fields,
            params: input.canonical_params,
          }),
  };
}
