import { mailRecipientsNotListed } from './recipientList';
import { MAIL_CONNECTOR_NAME, MAIL_SEND_TOOL_NAMES } from './toolContract';

/** The parts of a held or pending call that decide whether it needs new addresses on the Email list. */
export interface MailApprovalCall {
  tool_name: string;
  mcp_server_name: string | undefined;
  /** The call's JSON arguments, exactly as the model sent them. */
  arguments: string;
}

/** The arguments as an object, or an empty object when they are not one. Arguments are never trusted for more than this. */
function argumentsOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The addresses a mail send would reach that are not on the Email list. Read from the call's own arguments,
 * so the client never chooses which addresses join the list. Empty for any other call.
 */
export function newRecipientsOfMailCall(call: MailApprovalCall, listed: readonly string[]): string[] {
  if (call.mcp_server_name !== MAIL_CONNECTOR_NAME || !MAIL_SEND_TOOL_NAMES.some(name => name === call.tool_name)) {
    return [];
  }
  return mailRecipientsNotListed({ listed, params: argumentsOf(call.arguments) });
}

/** Shown when the server will not add an address, so nothing is sent. The draft is kept. */
export const NEW_RECIPIENT_REFUSED =
  'Aman could not add this address to your send list, so nothing was sent. Your draft is still here. Cancel it, or ask Aman to save it as a draft.';

/** Shown when the sidecar has not loaded the updated list in time. The address is kept on the list. */
export const SEND_LIST_STILL_UPDATING = 'Aman is still updating your send list. Try sending again in a moment.';
