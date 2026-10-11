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
  /** The call's exact arguments as "name: value" lines; only for connector (MCP) calls. */
  outbound_text: string | null;
  /** Host of the connector server that receives the call; only for connector (MCP) calls. */
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

/** Longest outbound_text sent to the UI; a cut is marked in the text itself. */
export const OUTBOUND_TEXT_MAX_CHARS = 20_000;

function argumentValueText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Every argument the connector will receive, verbatim, one "name: value" line each.
 * Built from the server's canonical params, so a model-written description can never
 * stand in for what is sent.
 */
export function renderOutboundArguments(params: Record<string, unknown>): string | null {
  const lines = Object.entries(params).map(([key, value]) => `${key}: ${argumentValueText(value)}`);
  if (lines.length === 0) {
    return null;
  }
  const text = lines.join('\n');
  if (text.length <= OUTBOUND_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, OUTBOUND_TEXT_MAX_CHARS)}\n... (cut at ${String(OUTBOUND_TEXT_MAX_CHARS)} characters)`;
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
    match: nameIncludes('send_email', 'sendemail', 'email_send'),
    extract: genericExtractor,
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
  match: (words: string) => boolean;
  describe: (input: ConnectorCallInput) => string;
  /** Replaces the destination when the params name a more precise one. */
  destination?: (params: Record<string, unknown>) => string | null;
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

/**
 * Connector actions that are not external-service by name but still send data out. They only
 * change the card's wording and destination: tiers, auto-deny and offline handling come from
 * the registry above. Checked in order.
 */
const CONNECTOR_FAMILIES: ConnectorFamily[] = [
  {
    match: words => hasPhrase(words, 'gist'),
    describe: ({ tool_name, where }) => `Publish a gist with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'push_files', 'create_or_update_file', 'create_repository'),
    describe: ({ tool_name, where, params }) => {
      const repo = repositoryLabel(params);
      return `Write to ${repo === null ? 'a repository' : `repository ${repo}`} with ${tool_name}${where}.`;
    },
    destination: repositoryLabel,
  },
  {
    match: words => hasPhrase(words, 'send_draft'),
    describe: ({ tool_name, where, fields }) => `Send a saved draft${toRecipient(fields)} with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'forward'),
    describe: ({ tool_name, where, fields }) => `Forward a message${toRecipient(fields)} with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'reply'),
    describe: ({ tool_name, where, fields }) => `Send a reply${toRecipient(fields)} with ${tool_name}${where}.`,
  },
  {
    match: words => hasPhrase(words, 'create_draft', 'draft_email', 'update_draft', 'gmail_draft'),
    describe: ({ tool_name, where, fields }) => `Save a message draft${toRecipient(fields)} with ${tool_name}${where}.`,
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
  /** Plain-words description of a known connector action (search, fetch, repo write, mail), or null. */
  connector_what: string | null;
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
      connector_what: null,
    };
  }
  const words = nameWords(input.tool_name);
  // Deleting or installing is described by the classifier's own destructive and install cards.
  const family = hasPhrase(words, ...DESTRUCTIVE_AND_INSTALL_WORDS)
    ? undefined
    : CONNECTOR_FAMILIES.find(f => f.match(words));
  const where = input.server_name === undefined || input.server_name === '' ? '' : ` on ${input.server_name}`;
  const fields: ExtractedCardFields = {
    ...base,
    destination: family?.destination?.(input.canonical_params) ?? base.destination,
    outbound_text: renderOutboundArguments(input.canonical_params),
    destination_host: input.server_host ?? (base.destination === null ? null : hostFromUrl(base.destination)),
  };
  return {
    fields,
    destination_unverifiable: destinationUnverifiable,
    external_service: externalService,
    connector_what:
      family === undefined
        ? null
        : family.describe({
            tool_name: input.tool_name,
            words,
            where,
            fields,
            params: input.canonical_params,
          }),
  };
}

/** True when the tool name denotes an external-service action. */
export function isExternalServiceAction(toolName: string): boolean {
  const entry = EXTRACTOR_REGISTRY.find(e => e.match(toolName));
  if (entry !== undefined) {
    return entry.external_service;
  }
  return EXTERNAL_SERVICE_FRAGMENTS.some(f => toolName.toLowerCase().includes(f));
}
