/**
 * A message the person sent through the assistant, read from the send call's arguments. The host
 * writes it to memory itself once the send ran, with no model call, so the record is exactly what
 * went out.
 */
import { namedMailRecipients } from '@truefoundry/trueforge-core/core/email/mailConnector/recipientList';
import {
  isMailSendToolName,
  MAIL_CONNECTOR_NAME,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { RawToolCall } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { parseToolCallArguments } from '@truefoundry/trueforge-core/core/mcp/toolArgumentCheck';
import { CALL_TOOL_NAME, tryParseCallToolWrapper } from '@truefoundry/trueforge-core/core/runtime/DeferredTool';

export interface SentMail {
  recipients: string[];
  subject: string;
  /** For a forward, only the text the person added; the forwarded message is not theirs. */
  body: string;
}

function stringField(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** The server and tool a call reached, unwrapping the deferred `call_tool` wrapper and the `<server>__` prefix. */
function calledTool(
  call: RawToolCall,
  args: Record<string, unknown>,
): { server: string; tool: string; args: Record<string, unknown> } | undefined {
  const isWrapper = call.function.name === CALL_TOOL_NAME || call.function.name.endsWith(`__${CALL_TOOL_NAME}`);
  if (isWrapper) {
    const wrapped = tryParseCallToolWrapper(args);
    return wrapped === undefined
      ? undefined
      : { server: wrapped.mcp_server, tool: wrapped.tool_name, args: wrapped.input };
  }
  const separator = call.function.name.lastIndexOf('__');
  return separator === -1
    ? undefined
    : { server: call.function.name.slice(0, separator), tool: call.function.name.slice(separator + 2), args };
}

/**
 * The message a call to the Email connector's send tools would deliver, or undefined when the call is not
 * a send, names no recipient, or has no readable arguments. A draft is not a send. Read when the call is
 * made; the caller keeps it only once the send ran.
 */
export function sentMailFromCall({
  call,
  maxBodyCharacters,
}: {
  call: RawToolCall;
  maxBodyCharacters: number;
}): SentMail | undefined {
  const parsed = parseToolCallArguments(call);
  const reached = parsed === undefined ? undefined : calledTool(call, parsed);
  if (reached?.server !== MAIL_CONNECTOR_NAME || !isMailSendToolName(reached.tool)) {
    return undefined;
  }
  const recipients = namedMailRecipients(reached.args);
  if (recipients.length === 0) {
    return undefined;
  }
  return {
    recipients,
    subject: stringField(reached.args, 'subject'),
    body: stringField(reached.args, 'body').slice(0, maxBodyCharacters),
  };
}

/** The note's sentence: who it went to, its subject, and the text, so the log reads as a plain record. */
export function sentMailNoteText(mail: SentMail): string {
  const to = `To ${mail.recipients.join(', ')}`;
  const subject = mail.subject === '' ? '' : `, subject "${mail.subject}"`;
  const body = mail.body === '' ? '' : `: ${mail.body}`;
  return `${to}${subject}${body}`;
}
