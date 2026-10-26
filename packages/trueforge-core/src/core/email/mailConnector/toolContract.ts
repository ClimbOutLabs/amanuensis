/**
 * The Email connector: the mail sidecar mounted as an ordinary MCP connector under this name. Only the
 * tools listed here are offered to the model; every other tool the sidecar exposes is hidden and cannot
 * be called. The list is the one owner of which mail tools exist for Aman.
 */
export const MAIL_CONNECTOR_NAME = 'Email';

export const MAIL_READ_TOOL_NAMES = [
  'list_emails_metadata',
  'get_emails_content',
  'get_attachment_content',
  'list_mailboxes',
] as const;

/** Whether the tool only reads mail. Reads run without a card; every other Email tool asks first. */
export function isMailReadToolName(tool_name: string): boolean {
  return MAIL_READ_TOOL_NAMES.some(name => name === tool_name);
}

/** Tools that deliver a message to recipients, so each recipient must be on the Email list. */
export const MAIL_SEND_TOOL_NAMES = ['send_email', 'forward_email'] as const;

export function isMailSendToolName(tool_name: string): boolean {
  return MAIL_SEND_TOOL_NAMES.some(name => name === tool_name);
}

export const MAIL_WRITE_TOOL_NAMES = ['save_draft', ...MAIL_SEND_TOOL_NAMES, 'archive_emails'] as const;

/** Every tool the model is offered on the Email connector, reads first. */
export const MAIL_CONNECTOR_TOOL_NAMES = [...MAIL_READ_TOOL_NAMES, ...MAIL_WRITE_TOOL_NAMES] as const;

/** Returns one message's attachment as base64 bytes; the host places them in the sandbox. */
export const MAIL_ATTACHMENT_TOOL_NAME = 'get_attachment_content';

/** The sidecar's own account list. Hidden from the model; the host reads it to fill in the account name. */
export const MAIL_ACCOUNT_LIST_TOOL_NAME = 'list_available_accounts';

/** The argument every Email tool takes to pick the mail account. */
export const MAIL_ACCOUNT_ARGUMENT = 'account_name';

/** Lists and searches messages; the host keeps it to a recent window when the call sets no date. */
export const MAIL_LIST_TOOL_NAME = 'list_emails_metadata';

/** Names a model tends to guess when it looks for the Email connector under another name. */
export function isMailConnectorGuess(name: string): boolean {
  const lowered = name.toLowerCase();
  return ['mail', 'inbox', 'outlook'].some(word => lowered.includes(word));
}
