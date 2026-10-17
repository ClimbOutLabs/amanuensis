/**
 * Record of what actually left this computer. Distinct from the approval audit log: that one
 * answers "what was decided", this one answers "what was sent, and to whom". Each row is written
 * where the request is made, never inferred later. Only hosts and sizes are kept, never the text.
 */
import { countRecipients } from './extractorRegistry';

export const OUTBOUND_EVENT_KINDS = [
  'model_request',
  'email_sent',
  'web_search',
  'map_lookup',
  'connector_call',
] as const;
export type OutboundEventKind = (typeof OUTBOUND_EVENT_KINDS)[number];

export interface OutboundEventInput {
  tenant_id: string;
  kind: OutboundEventKind;
  /** Host (and port when not the default) of the service that received the request. */
  host: string;
  model: string | null;
  tool_name: string | null;
  request_bytes: number | null;
  recipient_count: number | null;
  subject: string | null;
  conversation_id: string | null;
}

/**
 * Implementations must not throw: a failed write never blocks the request it describes. They also
 * decide what counts as leaving the computer, so callers hand over every request they send.
 */
export interface OutboundEventWriter {
  record(input: OutboundEventInput): Promise<void>;
}

const SUBJECT_MAX_CHARS = 120;

/** True for hosts that are this computer itself; a request to one never leaves it. */
export function isLoopbackHost(host: string): boolean {
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : (host.split(':')[0] ?? host);
  const lower = name.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || lower === '::1' || /^127\.\d+\.\d+\.\d+$/.test(lower);
}

/** Bytes of the JSON a connector call carries. */
export function argumentBytes(args: Record<string, unknown> | undefined): number {
  return new TextEncoder().encode(JSON.stringify(args ?? {})).length;
}

function isEmailSend(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return /send|reply|forward/.test(name) && /mail|draft/.test(name);
}

function subjectOf(args: Record<string, unknown> | undefined): string | null {
  const raw = args?.['subject'];
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') {
    return null;
  }
  return text.length > SUBJECT_MAX_CHARS ? `${text.slice(0, SUBJECT_MAX_CHARS)}...` : text;
}

/**
 * The row for one dispatched connector call, or null when the connector is not a remote server.
 * The designated search provider's calls are web searches; a send-style email tool is an email sent.
 */
export function connectorCallEvent(input: {
  tenant_id: string;
  conversation_id: string;
  host: string | undefined;
  tool_name: string;
  args: Record<string, unknown> | undefined;
  search_provider: boolean;
}): OutboundEventInput | null {
  if (input.host === undefined) {
    return null;
  }
  const email = !input.search_provider && isEmailSend(input.tool_name);
  return {
    tenant_id: input.tenant_id,
    kind: input.search_provider ? 'web_search' : email ? 'email_sent' : 'connector_call',
    host: input.host,
    model: null,
    tool_name: input.tool_name,
    request_bytes: argumentBytes(input.args),
    recipient_count: email ? countRecipients(input.args ?? {}) : null,
    subject: email ? subjectOf(input.args) : null,
    conversation_id: input.conversation_id,
  };
}
