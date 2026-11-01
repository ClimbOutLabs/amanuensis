import { isMorningBriefPrompt } from '@truefoundry/trueforge-core/core/schedules/morningBrief';

type ContentPart = { readonly type: string; readonly text?: unknown };

/** The text parts of a message, joined in order. */
export function messageText(content: readonly ContentPart[]): string {
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.join('\n');
}

/** Whether the message right before `messageId` is a morning brief request, so this answer is a brief. */
export function answersBriefPrompt(
  messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly content: readonly { readonly type: string }[];
  }[],
  messageId: string,
): boolean {
  const index = messages.findIndex(message => message.id === messageId);
  if (index <= 0) return false;
  const previous = messages[index - 1];
  return previous?.role === 'user' && isMorningBriefPrompt(messageText(previous.content));
}

/** The date a morning brief was requested on, from the first brief request in the thread; null for other chats. */
export function briefRequestDate(
  messages: readonly {
    readonly role: string;
    readonly content: readonly ContentPart[];
    readonly createdAt: Date;
  }[],
): Date | null {
  for (const message of messages) {
    if (message.role === 'user' && isMorningBriefPrompt(messageText(message.content))) return message.createdAt;
  }
  return null;
}
