/**
 * A message the person sent through the assistant, read from the send call's arguments and saved by the
 * host as its own note, with no model call, once the sidecar says it went through. It does not wait for the
 * turn to finish and does not depend on the turn's own memory save, so neither a turn that ends early nor a
 * lost turn takes the note with it.
 */
import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import {
  namedMailCopies,
  namedMailRecipients,
} from '@truefoundry/trueforge-core/core/email/mailConnector/recipientList';
import {
  isMailSendToolName,
  MAIL_CONNECTOR_NAME,
  mailSendOutcome,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { RawToolCall } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { parseToolCallArguments } from '@truefoundry/trueforge-core/core/mcp/toolArgumentCheck';
import { CALL_TOOL_NAME, tryParseCallToolWrapper } from '@truefoundry/trueforge-core/core/runtime/DeferredTool';
import { isRecord } from '@truefoundry/trueforge-core/core/util/records';
import type { Logger } from 'winston';
import configuration from '../../config';
import { redactSecretShapes } from '../../dataExport/secretScrub';
import { sessionKeepsNothing } from '../privateChat';
import { localDay } from './localDay';
import { REPLACE_DOCUMENT_METADATA_KEY } from './markdownMemoryFiles';
import type { MemoryClient } from './memoryClient';
import { labeledNoteText, noteLabel, SENT_MAIL_SOURCE } from './memoryNotes';
import { noteRetainItem, retainOperationId, startPageSorting, type SummarizeTurnContext } from './memoryRetain';

export interface SentMail {
  kind: 'send' | 'forward';
  recipients: string[];
  cc: string[];
  bcc: string[];
  /** Empty for a forward: the sidecar sets its subject, and the call carries none. */
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
 * a send or names no one to send to. A draft is not a send. Read when the call is made; the caller saves
 * it only once the result says it went through.
 */
export function sentMailFromCall(call: RawToolCall): SentMail | undefined {
  const parsed = parseToolCallArguments(call);
  const reached = parsed === undefined ? undefined : calledTool(call, parsed);
  if (reached?.server !== MAIL_CONNECTOR_NAME || !isMailSendToolName(reached.tool)) {
    return undefined;
  }
  const recipients = namedMailRecipients(reached.args);
  const { cc, bcc } = namedMailCopies(reached.args);
  if (recipients.length + cc.length + bcc.length === 0) {
    return undefined;
  }
  const forward = reached.tool === 'forward_email';
  return {
    kind: forward ? 'forward' : 'send',
    recipients,
    cc,
    bcc,
    subject: forward ? '' : stringField(reached.args, 'subject'),
    body: stringField(reached.args, 'body'),
  };
}

/** The text of a tool result, read from the host's result envelope, a structured `result`, or content blocks. */
function resultText(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') {
    if (depth < 3 && value.startsWith('{')) {
      try {
        return resultText(JSON.parse(value), depth + 1) ?? value;
      } catch {
        return value;
      }
    }
    return value;
  }
  if (!isRecord(value) || depth >= 3) {
    return undefined;
  }
  if ('result' in value) {
    return resultText(value['result'], depth + 1);
  }
  const content = value['content'];
  if (Array.isArray(content)) {
    const texts = content.flatMap(block =>
      isRecord(block) && typeof block['text'] === 'string' ? [block['text']] : [],
    );
    return texts.length === 0 ? undefined : texts.join('\n');
  }
  return undefined;
}

/**
 * Whether a send's tool result (the `content` of its terminal event) says the message went out. The
 * sidecar reports a failed or uncertain delivery as a normal result, so its text is read, not only its status.
 */
export function sentMailWentThrough(eventContent: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventContent);
  } catch {
    return false;
  }
  const text = resultText(parsed);
  return text !== undefined && mailSendOutcome(text.trim()) === 'sent';
}

/**
 * Longest body kept, in characters: the same bound as the facts a turn summary may store, so a sent note is
 * no bigger than any other memory note. A longer body is cut and says so.
 */
export const SENT_MAIL_BODY_MAX_CHARACTERS = 2_000;

const CUT_MARKER = ' (cut)';

/**
 * The note's sentence: who it went to, the subject if the call set one, and the text, so the log reads as
 * a plain record. A text longer than the limit is cut on a whole character and says so. Undefined when the
 * whole message holds something shaped like a secret; such a message is not saved.
 */
export function sentMailNoteText({
  mail,
  maxBodyCharacters = SENT_MAIL_BODY_MAX_CHARACTERS,
}: {
  mail: SentMail;
  maxBodyCharacters?: number;
}): string | undefined {
  const addressed = [
    ...(mail.recipients.length === 0 ? [] : [mail.recipients.join(', ')]),
    ...(mail.cc.length === 0 ? [] : [`cc ${mail.cc.join(', ')}`]),
    ...(mail.bcc.length === 0 ? [] : [`bcc ${mail.bcc.join(', ')}`]),
  ].join(', ');
  const who = `${mail.kind === 'forward' ? 'Forwarded to' : 'To'} ${addressed}`;
  const subject = mail.subject === '' ? '' : `, subject "${mail.subject}"`;
  if (redactSecretShapes(`${who}${subject}: ${mail.body}`) !== `${who}${subject}: ${mail.body}`) {
    return undefined;
  }
  const characters = Array.from(mail.body);
  const body =
    characters.length > maxBodyCharacters
      ? `${characters.slice(0, maxBodyCharacters).join('')}${CUT_MARKER}`
      : mail.body;
  return `${who}${subject}${body === '' ? '' : `: ${body}`}`;
}

/**
 * Saves one sent message as a daily-log note. Never throws: a memory failure must not touch the turn.
 * Each send has its own operation id, so saving the same send twice writes it once. A message sent
 * from a private chat is not saved: the message went out, but the chat keeps nothing.
 */
export async function saveSentMail({
  client,
  session,
  sessionId,
  turnId,
  threadId,
  callId,
  mail,
  sentAt,
  timeZone,
  summarize,
  logger,
}: {
  client: MemoryClient;
  /** The chat the send was made in. */
  session: Pick<SessionRecord, 'is_incognito'>;
  sessionId: string;
  turnId: string;
  threadId: string;
  callId: string;
  mail: SentMail;
  sentAt: string;
  timeZone: string | undefined;
  /** The model to sort the saved note with; without it the note is saved and left unsorted. */
  summarize?: SummarizeTurnContext | undefined;
  logger: Logger;
}): Promise<void> {
  if (sessionKeepsNothing({ session })) {
    return;
  }
  try {
    const text = sentMailNoteText({ mail });
    if (text === undefined) {
      logger.debug('A sent message holds a secret and was not saved as a note', { sessionId, turnId });
      return;
    }
    const instant = new Date(sentAt);
    const date = localDay({ instant: Number.isNaN(instant.getTime()) ? new Date() : instant, timeZone }).date;
    const noteItem = noteRetainItem({
      sessionId,
      turnId,
      completedAt: sentAt,
      note: {
        source: SENT_MAIL_SOURCE,
        date,
        text: labeledNoteText({ label: noteLabel({ source: SENT_MAIL_SOURCE, date, assistantName: undefined }), text }),
      },
      documentId: `aman-${sessionId}-${turnId}-sent-${threadId}-${callId}`,
      chatReadNothing: false,
    });
    // A retry after a half-finished save replaces the copy that attempt wrote, so the note is never doubled.
    const item = { ...noteItem, metadata: { ...noteItem.metadata, [REPLACE_DOCUMENT_METADATA_KEY]: 'true' } };
    const request = {
      items: [item],
      // Names the turn too: a model may reuse a call id in a later turn, and that send is a different message.
      operationId: retainOperationId({ sessionId, turnId: `sent/${turnId}/${threadId}/${callId}` }),
      timeoutMs: configuration.MEMORY_RETAIN_TIMEOUT_MS,
    };
    // One retry, since nothing else will save this note if the first attempt does not land.
    const first = await client.retain(request);
    const outcome = first.ok ? first : await client.retain(request);
    if (!outcome.ok) {
      logger.warn('A sent message could not be saved to memory', { sessionId, turnId, reason: first.reason });
      return;
    }
    startPageSorting({ client, written: outcome.written, summarize, timeZone, logger });
  } catch (error) {
    logger.warn('A sent message could not be saved to memory', { sessionId, turnId, ...extractErrorLogFields(error) });
  }
}
