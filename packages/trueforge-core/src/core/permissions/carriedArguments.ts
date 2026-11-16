import { isRecord } from '../util/records.js';
import type { ExtractedCardFields } from './extractorRegistry.js';

/** Lower-cased key without separators, so `emailAddress` and `email_address` compare equal. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Param keys that can carry a destination. */
export const DESTINATION_KEYS = [
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

/** Param keys that hold the composed message itself: the words that would be delivered. */
const MESSAGE_CONTENT_KEYS = ['subject', 'body', 'message'];
const MESSAGE_CONTENT_KEY_SET = new Set(MESSAGE_CONTENT_KEYS.map(normalizeKey));

/** Param keys whose value is text or data that would be delivered, on a call already known to send. */
const DELIVERED_KEY_SET = new Set([...MESSAGE_CONTENT_KEYS, 'text', 'data', 'payload'].map(normalizeKey));

/**
 * Param keys that reference a message in an external service. A call that is not a known read
 * and points at one acts on external content the host cannot see, so what it reaches is no more
 * verifiable than a destination named outright.
 */
const MESSAGE_REFERENCE_KEY_SET = new Set(['message_id'].map(normalizeKey));

/**
 * Param keys that reference a mailbox. A mailbox is a folder in the connector's own store, like
 * a repository, so naming one is not on its own a reach outside. It counts as a reference only
 * when the tool's name is disguised (see externalServiceCarried): a name with lookalike or
 * hidden characters cannot be taken for the read it resembles.
 */
const MAILBOX_REFERENCE_KEY_SET = new Set(['mailbox'].map(normalizeKey));

/** Every destination key, normalized: a value under one of these is the destination itself, never delivered content. */
const DESTINATION_KEY_SET = new Set(DESTINATION_KEYS.map(normalizeKey));

/** True when a value holds words: a non-empty string, or a list holding one. */
function hasWords(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  return Array.isArray(value) && value.some(hasWords);
}

/** True when any top-level argument under one of the keys holds words. */
function carriesWords(params: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.entries(params).some(([key, value]) => keys.has(normalizeKey(key)) && hasWords(value));
}

/** True when a top-level argument under one of the keys names something in an external service. */
function carriesReference(params: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.entries(params).some(
    ([key, value]) =>
      keys.has(normalizeKey(key)) &&
      value !== null &&
      value !== undefined &&
      !(typeof value === 'string' && value.trim() === ''),
  );
}

/** True when a value carries payload: words at any depth, or a number standing as an id or a quantity. */
function carriesPayloadValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim() !== '';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(carriesPayloadValue);
  }
  return isRecord(value) && Object.values(value).some(carriesPayloadValue);
}

/**
 * True when an argument outside the destination keys and the mailbox keys carries words or an id.
 * The destination keys name where a call goes, so their values are the destination itself, and a
 * mailbox is a folder in the connector's own store: neither one is payload carried somewhere unseen.
 */
function carriesUnaddressedPayload(params: Record<string, unknown>): boolean {
  return Object.entries(params).some(([key, value]) => {
    const normalized = normalizeKey(key);
    return (
      !DESTINATION_KEY_SET.has(normalized) && !MAILBOX_REFERENCE_KEY_SET.has(normalized) && carriesPayloadValue(value)
    );
  });
}

/** True when the tool name holds a lookalike or hidden character, so its words cannot be taken at face value. */
function nameIsDisguised(toolName: string): boolean {
  return !/^[A-Za-z0-9._ -]+$/.test(toolName);
}

/** True when any top-level argument outside the destination keys holds words: content a named destination would receive. */
function carriesOtherWords(params: Record<string, unknown>): boolean {
  return Object.entries(params).some(([key, value]) => !DESTINATION_KEY_SET.has(normalizeKey(key)) && hasWords(value));
}

/**
 * Whether the call reaches an external service with something addressed out, computed once from
 * what the call carries and from the tool's declared annotations, never from fragments in the
 * tool's name: it is addressed to a recipient, carries an amount, delivers words or data to a
 * destination outside the connector's own store, carries a composed message, or points at a
 * message it acts on. A mailbox it names counts only when its name is disguised, since a mailbox
 * is the connector's own store and a plain name can be taken at face value. A tool declared
 * read-only and closed-world is not counted as addressed by its arguments alone, since a read's
 * arguments can name the person or place it reads about: only what it carries to deliver counts
 * there. A call that only stages a draft delivers nothing, so it never counts. A call a
 * connector family describes without sending (a fetch, a search, an archive) is not counted as
 * delivering to a destination it names, since that family already says what the call does there.
 *
 * The same computation reports whether the call carries payload with nowhere verifiable to go:
 * a call no connector family claims, which is not a known read, is not declared read-only and
 * closed-world, and does not name a mailbox (a mailbox anchors the call in the connector's own
 * store, so its other arguments name things inside that store), yet carries words or an id under
 * a key that is neither a destination key nor a mailbox key. That verdict is reported apart from
 * external-service itself, because a call that does show a destination is an ordinary send to
 * it, not an unverifiable one: the extraction adds the shown-destination conditions.
 */
export function externalServiceCarried(input: {
  params: Record<string, unknown>;
  fields: Pick<ExtractedCardFields, 'recipient' | 'amount'>;
  addressed_recipients: readonly string[];
  /** An argument names a destination outside the connector's own store. */
  names_external_destination: boolean;
  staged_draft: boolean;
  read_only_closed_world: boolean;
  tool_name: string;
  nonsend_family: boolean;
  /** No connector family claims the call, so no family's own rules govern what it carries. */
  unclaimed: boolean;
  /** The call is a known connector read (see isConnectorRead). */
  connector_read: boolean;
}): { external_service: boolean; unverifiable_payload: boolean } {
  if (input.staged_draft) {
    return { external_service: false, unverifiable_payload: false };
  }
  const addressed =
    !input.read_only_closed_world &&
    (input.fields.recipient !== null || input.fields.amount !== null || input.addressed_recipients.length > 0);
  const deliversToDestination =
    input.names_external_destination &&
    (carriesWords(input.params, DELIVERED_KEY_SET) || (!input.nonsend_family && carriesOtherWords(input.params)));
  const externalService =
    addressed ||
    deliversToDestination ||
    carriesWords(input.params, MESSAGE_CONTENT_KEY_SET) ||
    carriesReference(input.params, MESSAGE_REFERENCE_KEY_SET) ||
    (nameIsDisguised(input.tool_name) && carriesReference(input.params, MAILBOX_REFERENCE_KEY_SET));
  const unverifiablePayload =
    input.unclaimed &&
    !input.connector_read &&
    !input.read_only_closed_world &&
    !carriesReference(input.params, MAILBOX_REFERENCE_KEY_SET) &&
    carriesUnaddressedPayload(input.params);
  return { external_service: externalService, unverifiable_payload: unverifiablePayload };
}

/**
 * Whether the call delivers a message to a person, so every part of its arguments must be fully
 * visible: a message family, or a call addressed to a recipient that carries the delivered text.
 */
export function deliversMessageCarried(input: {
  family_sends_message: boolean;
  fields: Pick<ExtractedCardFields, 'recipient'>;
  nested_recipients: readonly string[];
  params: Record<string, unknown>;
}): boolean {
  if (input.family_sends_message) {
    return true;
  }
  const addressed = input.fields.recipient !== null || input.nested_recipients.length > 0;
  return addressed && carriesWords(input.params, DELIVERED_KEY_SET);
}
