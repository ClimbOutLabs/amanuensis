/**
 * Private chats: a chat Aman does not remember. Every writer that would keep something from a chat
 * asks `sessionKeepsNothing` first. Actions still leave receipts, so approvals and audits never ask.
 */
import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability, InstructionBuilder, ToolDefinition } from '@truefoundry/trueforge-core/core';

/** A private chat is deleted this long after its last turn if it is not closed first. */
export const PRIVATE_CHAT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const PRIVATE_CHAT_FLAG_CHANGE_MESSAGE =
  'A chat is incognito from the start or not at all. Start a new incognito chat instead.';

export const PRIVATE_CHAT_FOLDER_MESSAGE =
  'Incognito chats cannot be added to a folder. Start a normal chat to keep it in one.';

export const PRIVATE_CHAT_BUG_REPORT_MESSAGE =
  'Bug reports never include incognito chats. Send a report from Help instead and describe the problem in words.';

export const PRIVATE_CHAT_BRIEF_MESSAGE =
  'Incognito chats are not part of the brief. Mark the item done from the brief chat.';

/** True when nothing from this chat may be written anywhere that outlives it. */
export function sessionKeepsNothing({ session }: { session: Pick<SessionRecord, 'is_incognito'> }): boolean {
  return session.is_incognito;
}

/** When a private chat is deleted, counted from its latest activity. */
export function privateChatExpiry({ from }: { from: Date }): Date {
  return new Date(from.getTime() + PRIVATE_CHAT_LIFETIME_MS);
}

/**
 * The tools of one tool set that a chat is offered. A chat that keeps nothing gets only the tools that
 * read, plus `chatOnly`: tools that change this chat and nothing that outlives it. A tool that writes
 * is left out until it says otherwise, so a new writer cannot slip into a private chat.
 */
export function toolsForChat({
  tools,
  keepsNothing,
  chatOnly,
}: {
  tools: readonly ToolDefinition[];
  keepsNothing: boolean;
  chatOnly: ReadonlySet<string>;
}): ToolDefinition[] {
  return keepsNothing
    ? tools.filter(tool => tool.annotations?.readOnlyHint === true || chatOnly.has(tool.name))
    : [...tools];
}

const PRIVATE_CHAT_INSTRUCTION_SECTION = 'incognito_chat';
const PRIVATE_CHAT_INSTRUCTION =
  'This is an incognito chat. Nothing from it may outlive it, so here you cannot make or change spaces, reminders, schedules or personas, and the web browser is off. You can still read spaces, schedules and reminders, and switch persona. When the user asks for something you cannot do here, say so plainly and tell them to ask again in a normal chat.';

function buildPrivateChatInstruction(builder: InstructionBuilder): void {
  builder.addSection(PRIVATE_CHAT_INSTRUCTION_SECTION, PRIVATE_CHAT_INSTRUCTION);
}

/** Tells the model of a private chat what it cannot do there and what to say instead. */
export function privateChatCapability(): AgentCapability {
  return { instructionBuilders: [buildPrivateChatInstruction] };
}
