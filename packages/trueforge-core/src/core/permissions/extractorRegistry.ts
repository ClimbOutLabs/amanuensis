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
