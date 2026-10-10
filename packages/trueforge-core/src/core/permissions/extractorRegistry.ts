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

export interface ExtractedCardFields {
  destination: string | null;
  recipient: string | null;
  amount: string | null;
  /** Exact text leaving the machine (query, URL, message preview), truncated to 500 chars. */
  outbound_text: string | null;
  /** Host the call reaches, from a URL argument or the connector server URL. */
  destination_host: string | null;
}

export type CardFieldExtractor = (params: Record<string, unknown>) => ExtractedCardFields;

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
];

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

function stringValues(params: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '') {
      out.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') {
          out.push(item.trim());
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
    recipient: joinOrNull(stringValues(params, RECIPIENT_KEYS)),
    amount: firstOrNull(stringValues(params, AMOUNT_KEYS)),
    outbound_text: null,
    destination_host: null,
  };
}

/** Max characters for outbound_text; longer text is truncated with a marker. */
const OUTBOUND_TEXT_MAX_LENGTH = 500;

function truncateOutboundText(text: string): string {
  if (text.length <= OUTBOUND_TEXT_MAX_LENGTH) {
    return text;
  }
  return text.slice(0, OUTBOUND_TEXT_MAX_LENGTH) + '... (truncated)';
}

/** Extract the host from a URL string, handling protocol-relative URLs. Null when not a URL. */
function hostFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const trimmed = value.trim();
  try {
    const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const url = new URL(normalized);
    return url.host !== '' ? url.host : null;
  } catch {
    return null;
  }
}

/** First non-empty string value for the given keys, or null. */
function firstParam(params: Record<string, unknown>, keys: string[]): string | null {
  return firstOrNull(stringValues(params, keys));
}

/** Param keys that can carry a search query. */
const SEARCH_QUERY_KEYS = ['query', 'q', 'search_query', 'text', 'keywords', 'search_text'];

/** Param keys that can carry a URL to fetch. */
const FETCH_URL_KEYS = ['url', 'link', 'href', 'target_url'];

/**
 * Search tools: any tool whose name indicates search, plus the known search
 * connectors. The outbound text is the query; the destination defaults to
 * 'web search' so the card shows instead of auto-denying (there is no URL or
 * recipient to verify, but the service is known).
 */
function searchExtractor(params: Record<string, unknown>): ExtractedCardFields {
  const base = genericExtractor(params);
  const query = firstParam(params, SEARCH_QUERY_KEYS);
  return {
    ...base,
    destination: base.destination ?? 'web search',
    outbound_text: query === null ? null : truncateOutboundText(query),
  };
}

/**
 * Fetch tools: the outbound text is the URL being fetched, and the host is
 * parsed from it.
 */
function fetchExtractor(params: Record<string, unknown>): ExtractedCardFields {
  const base = genericExtractor(params);
  const url = firstParam(params, FETCH_URL_KEYS);
  return {
    ...base,
    destination: url ?? base.destination,
    outbound_text: url === null ? null : truncateOutboundText(url),
    destination_host: hostFromUrl(url),
  };
}

/** Param keys for GitHub write tools. */
const GITHUB_OWNER_KEYS = ['owner'];
const GITHUB_REPO_KEYS = ['repo', 'repository', 'repository_name'];
const GITHUB_BRANCH_KEYS = ['branch', 'ref', 'base_branch'];
const GITHUB_FILE_KEYS = ['path', 'file_path', 'filepath', 'filename'];
const GITHUB_CONTENT_KEYS = ['content', 'body', 'text'];

/**
 * GitHub writes: owner/repo, branch, visibility, and file paths. The content
 * preview shows what is being written.
 */
function githubWriteExtractor(params: Record<string, unknown>): ExtractedCardFields {
  const base = genericExtractor(params);
  const owner = firstParam(params, GITHUB_OWNER_KEYS);
  const repo = firstParam(params, GITHUB_REPO_KEYS);
  const branch = firstParam(params, GITHUB_BRANCH_KEYS);
  const filePaths = stringValues(params, GITHUB_FILE_KEYS);
  const visibility = firstParam(params, ['visibility', 'public', 'private']);
  const content = firstParam(params, GITHUB_CONTENT_KEYS);

  const repoLabel = owner !== null && repo !== null ? `${owner}/${repo}` : (repo ?? owner);
  const lines: string[] = [];
  if (repoLabel !== null) {
    lines.push(`Repository: ${repoLabel}`);
  }
  if (branch !== null) {
    lines.push(`Branch: ${branch}`);
  }
  if (visibility !== null) {
    lines.push(`Visibility: ${visibility}`);
  }
  if (filePaths.length > 0) {
    lines.push(`Files: ${filePaths.join(', ')}`);
  }
  if (content !== null) {
    lines.push(`Content preview: ${content.slice(0, 200)}`);
  }
  const outbound = lines.length === 0 ? null : truncateOutboundText(lines.join('\n'));

  return {
    ...base,
    destination: repoLabel ?? base.destination,
    outbound_text: outbound,
    destination_host: 'github.com',
  };
}

/** Param keys for email subject and body. */
const EMAIL_SUBJECT_KEYS = ['subject', 'title'];
const EMAIL_BODY_KEYS = ['body', 'message', 'text', 'content', 'html'];

/**
 * Gmail send, reply, forward, and draft: recipients come from the generic
 * extractor; the outbound text adds subject and a body preview.
 */
function gmailExtractor(params: Record<string, unknown>): ExtractedCardFields {
  const base = genericExtractor(params);
  const subject = firstParam(params, EMAIL_SUBJECT_KEYS);
  const body = firstParam(params, EMAIL_BODY_KEYS);

  const lines: string[] = [];
  if (base.recipient !== null) {
    lines.push(`To: ${base.recipient}`);
  }
  if (subject !== null) {
    lines.push(`Subject: ${subject}`);
  }
  if (body !== null) {
    lines.push(`Body preview: ${body.slice(0, 200)}`);
  }
  const outbound = lines.length === 0 ? null : truncateOutboundText(lines.join('\n'));

  return {
    ...base,
    outbound_text: outbound,
  };
}

interface ExtractorEntry {
  match: (toolName: string) => boolean;
  extract: CardFieldExtractor;
  external_service: boolean;
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
    match: nameIncludes('send_email', 'sendemail', 'email_send', 'gmail_send', 'gmail_reply', 'gmail_forward'),
    extract: gmailExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('create_draft', 'draft_email', 'gmail_draft'),
    extract: gmailExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('send_message', 'sendmessage', 'message_send', 'send_sms', 'sendsms'),
    extract: genericExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('post_message', 'publish_post', 'create_post', 'post_tweet', 'share_post'),
    extract: genericExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('payment', 'pay_invoice', 'spend', 'transfer_funds', 'charge_card', 'create_charge'),
    extract: genericExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('share', 'webhook'),
    extract: genericExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('push_files', 'create_or_update_file', 'create_repository', 'create_gist', 'update_gist', 'gist'),
    extract: githubWriteExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('fetch_url', 'web_fetch', 'fetchurl', 'get_url', 'http_get', 'fetch_page', 'webfetch'),
    extract: fetchExtractor,
    external_service: true,
  },
  {
    match: nameIncludes('search', 'exa', 'tavily', 'parallel', 'bright_data', 'brightdata'),
    extract: searchExtractor,
    external_service: true,
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
}

/**
 * Extract card fields for a Tier 3 action. Never reads agent text: only the
 * canonical params the server parsed.
 */
export function extractCardFields(input: {
  tool_name: string;
  canonical_params: Record<string, unknown>;
}): ExtractionResult {
  const entry = EXTRACTOR_REGISTRY.find(e => e.match(input.tool_name));
  const externalService =
    entry?.external_service ?? EXTERNAL_SERVICE_FRAGMENTS.some(f => input.tool_name.toLowerCase().includes(f));
  const fields = entry !== undefined ? entry.extract(input.canonical_params) : genericExtractor(input.canonical_params);
  const destinationUnverifiable = externalService && fields.destination === null && fields.recipient === null;
  return { fields, destination_unverifiable: destinationUnverifiable, external_service: externalService };
}

/** True when the tool name denotes an external-service action. */
export function isExternalServiceAction(toolName: string): boolean {
  const entry = EXTRACTOR_REGISTRY.find(e => e.match(toolName));
  if (entry !== undefined) {
    return entry.external_service;
  }
  return EXTERNAL_SERVICE_FRAGMENTS.some(f => toolName.toLowerCase().includes(f));
}
