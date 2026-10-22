import { MAIL_CONNECTOR_NAME, MAIL_SEND_TOOL_NAMES } from './toolContract';

/**
 * Whether a call delivers mail through the Email connector. Takes the real tool name and server, never the name
 * the model saw, so a renamed or wrapped call is still checked.
 */
export function isMailSend(call: { mcp_server_name: string | undefined; tool_name: string | undefined }): boolean {
  return call.mcp_server_name === MAIL_CONNECTOR_NAME && MAIL_SEND_TOOL_NAMES.some(name => name === call.tool_name);
}

/** Shown when the server will not add an address, so nothing is sent. The draft is kept. */
export const NEW_RECIPIENT_REFUSED =
  'Aman could not add this address to your send list, so nothing was sent. Your draft is still here. Cancel it, or ask Aman to save it as a draft.';

/** Shown when the sidecar has not loaded the updated list in time. The address is kept on the list. */
export const SEND_LIST_STILL_UPDATING = 'Aman is still updating your send list. Try sending again in a moment.';
