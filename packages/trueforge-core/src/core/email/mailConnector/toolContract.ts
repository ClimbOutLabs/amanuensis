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

/** Tools that deliver a message to recipients, so each recipient must be on the Email list. */
export const MAIL_SEND_TOOL_NAMES = ['send_email', 'forward_email'] as const;

export const MAIL_WRITE_TOOL_NAMES = ['save_draft', ...MAIL_SEND_TOOL_NAMES, 'archive_emails'] as const;

/** Every tool the model is offered on the Email connector, reads first. */
export const MAIL_CONNECTOR_TOOL_NAMES = [...MAIL_READ_TOOL_NAMES, ...MAIL_WRITE_TOOL_NAMES] as const;

/** Returns one message's attachment as base64 bytes; the host places them in the sandbox. */
export const MAIL_ATTACHMENT_TOOL_NAME = 'get_attachment_content';
