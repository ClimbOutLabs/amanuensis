import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Tier3Card } from '@truefoundry/trueforge-core/core';
import type { ActionRequiredEvent, ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import type {
  Tier3CalendarEventSchema,
  Tier3EmailSchema,
  Tier3PersonaSchema,
  Tier3ScheduleSchema,
  Tier3SkillSchema,
} from '@truefoundry/trueforge-core/core/permissions/tier';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { ITelegramStore, TelegramConnection, TelegramPendingReply } from '../../db/telegramStore';
import { telegramCallbackData } from './telegramChannel';
import { TELEGRAM_MAX_MESSAGE_CHARS } from './telegramClient';
import { sendTelegramText, type TelegramSendQueue } from './telegramSendQueue';
import type { TelegramService } from './telegramService';

/**
 * Sends the answers Telegram is owed. A turn's answer always lands in the app first; this pass
 * reads the finished turn and sends its reply and any approval asks to the paired chat. The debt
 * is cleared before the first send goes out, the way the delivery layer records its work before
 * it sends: Telegram gives a send no idempotency key, so a send that may already have gone out
 * is never repeated, and a crash mid-pass must not let the next pass send the same answer twice.
 * The trade is the other way round from a retry: a crash between clearing the debt and a send
 * landing leaves that one copy unsent, and the answer stays in the Telegram chat in the app. A
 * failed send is logged the same way; it is never repeated either.
 */

const TURN_ERROR_LINE = 'Something went wrong with that answer. Open Aman to see the chat, or send the message again.';
const TURN_CANCELLED_LINE = 'That was stopped in Aman, so there is no answer to send.';
const APP_ONLY_LINE = 'Aman needs something only the app can give. Open Aman to continue.';

/** How many owed replies one pass works through. */
export const TELEGRAM_PENDING_REPLY_BATCH = 20;

export interface TelegramReplyDeps {
  store: ITelegramStore;
  service: TelegramService;
  queue: TelegramSendQueue;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getTurn'>;
  logger: Logger;
}

/** The readable text of a finished turn's last message, or undefined when it ended without one. */
export function modelMessageText(output: ModelMessageEvent | null): string | undefined {
  if (output === null) {
    return undefined;
  }
  const content: unknown = output.content;
  if (typeof content === 'string') {
    return content.trim() === '' ? undefined : content;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      const record = z.record(z.string(), z.unknown()).safeParse(part);
      if (!record.success) {
        continue;
      }
      const text = record.data['text'];
      if (record.data['type'] === 'text' && typeof text === 'string') {
        texts.push(text);
      }
    }
    const joined = texts.join('');
    return joined.trim() === '' ? undefined : joined;
  }
  return undefined;
}

/** One email recipient as the cards show it: `Name (address)`, or the bare address when it has no name. */
function mailboxLine(mailbox: { name: string; address: string }): string {
  return mailbox.name === '' ? mailbox.address : `${mailbox.name} (${mailbox.address})`;
}

/**
 * The card fields Telegram shows. A card that carries any other field is never sent with buttons,
 * so a field added to the card later cannot be approved from Telegram before it is shown here.
 * `outbound_plumbing_text` repeats lines of `outbound_text`, and `mail_draft` only names the button.
 */
export const TELEGRAM_SHOWN_CARD_FIELDS = [
  'plain_what',
  'plain_why',
  'cannot_be_undone',
  'why_asked_again',
  'destination',
  'recipient',
  'amount',
  'parsed_command',
  'outbound_text',
  'destination_host',
  'outbound_truncated',
  'outbound_plumbing_text',
  'email',
  'calendar_event',
  'schedule',
  'persona',
  'skill',
  'mail_new_recipients',
  'mail_draft',
] as const satisfies readonly (keyof Tier3Card)[];

/**
 * The fields Telegram shows inside each card section, held to the same rule. A calendar event's
 * `action` shows as its heading: "Now:" and "After the change:" for a change, "Exactly what will be
 * saved:" for a new event.
 */
export const TELEGRAM_SHOWN_SECTION_FIELDS = {
  email: [
    'action',
    'to',
    'cc',
    'bcc',
    'subject',
    'body',
    'replaces',
    'reply_in_thread',
    'reply_to',
    'from_name',
    'name_left_off',
  ] as const satisfies readonly (keyof z.infer<typeof Tier3EmailSchema>)[],
  calendar_event: [
    'action',
    'calendar',
    'title',
    'when',
    'time_zone',
    'duration',
    'location',
    'description',
    'attendees',
    'guests_emailed',
    'one_of_repeating',
    'before',
    'already_created',
    'span_days',
  ] as const satisfies readonly (keyof z.infer<typeof Tier3CalendarEventSchema>)[],
  schedule: [
    'action',
    'name',
    'when',
    'time_zone',
    'task',
    'runs_as',
    'next_runs',
  ] as const satisfies readonly (keyof z.infer<typeof Tier3ScheduleSchema>)[],
  persona: ['name', 'description', 'instructions', 'model_name'] as const satisfies readonly (keyof z.infer<
    typeof Tier3PersonaSchema
  >)[],
  skill: [
    'name',
    'description',
    'source',
    'version',
    'starter',
    'instructions',
  ] as const satisfies readonly (keyof z.infer<typeof Tier3SkillSchema>)[],
};

/** True when the object carries a set field that is not in the shown list. */
function hasUnshownField(input: { value: object; shown: readonly string[] }): boolean {
  const shown = new Set(input.shown);
  return Object.entries(input.value).some(
    ([field, value]) => value !== null && value !== undefined && !shown.has(field),
  );
}

/** True when the card, or one of its sections, carries a field Telegram does not show. */
function cardHasUnshownField(card: Tier3Card): boolean {
  if (hasUnshownField({ value: card, shown: TELEGRAM_SHOWN_CARD_FIELDS })) {
    return true;
  }
  const sections: readonly { value: object | null | undefined; shown: readonly string[] }[] = [
    { value: card.email, shown: TELEGRAM_SHOWN_SECTION_FIELDS.email },
    { value: card.calendar_event, shown: TELEGRAM_SHOWN_SECTION_FIELDS.calendar_event },
    { value: card.schedule, shown: TELEGRAM_SHOWN_SECTION_FIELDS.schedule },
    { value: card.persona, shown: TELEGRAM_SHOWN_SECTION_FIELDS.persona },
    { value: card.skill, shown: TELEGRAM_SHOWN_SECTION_FIELDS.skill },
  ];
  return sections.some(
    section =>
      section.value !== null &&
      section.value !== undefined &&
      hasUnshownField({ value: section.value, shown: section.shown }),
  );
}

/**
 * How much of a skill's own instruction file Telegram sends: three messages' worth. A longer file is
 * cut, and like a cut request it cannot be approved from Telegram.
 */
export const TELEGRAM_SKILL_INSTRUCTIONS_CHARS = 3 * TELEGRAM_MAX_MESSAGE_CHARS;
const SKILL_INSTRUCTIONS_CUT_LINE = "Part of the skill's instructions is not shown in full.";

function skillInstructionsCut(instructions: string): boolean {
  return instructions.length > TELEGRAM_SKILL_INSTRUCTIONS_CHARS;
}

/** True when part of what the card shows was cut for Telegram, or was already cut on the card. */
function cardIsCut(card: Tier3Card): boolean {
  const instructions = card.skill?.instructions ?? null;
  return card.outbound_truncated || (instructions !== null && skillInstructionsCut(instructions));
}

/**
 * Every line of one approval card, in the order the app's card shows them: what will happen,
 * the exact details (the whole email, the whole calendar event, a schedule's whole task, a
 * persona's whole instructions, a skill's source, version and instructions, the shell command,
 * the exact request a connector will get), what cannot be undone, and the reason last. Nothing the card shows is left out: a person
 * approving from Telegram decides on the same words as a person approving in the app.
 */
function approvalCardLines(card: Tier3Card): string[] {
  const lines: string[] = [card.plain_what];
  if (card.why_asked_again !== null) {
    lines.push(card.why_asked_again);
  }
  if (card.recipient !== null) {
    lines.push(`To: ${card.recipient}`);
  }
  if (card.destination !== null) {
    lines.push(`Where: ${card.destination}`);
  }
  if (card.destination_host !== null) {
    lines.push(`Sends to: ${card.destination_host}`);
  }
  if (card.amount !== null) {
    lines.push(`Amount: ${card.amount}`);
  }
  if (card.parsed_command !== null) {
    lines.push(`Command: ${card.parsed_command}`);
  }
  const email = card.email ?? null;
  if (email !== null) {
    lines.push(email.action === 'send' ? 'What will be sent:' : 'What will be saved:');
    if (email.reply_in_thread !== null) {
      lines.push(`Reply in the thread of the message from ${email.reply_in_thread.from}.`);
      lines.push(`Thread subject: ${email.reply_in_thread.subject}`);
    }
    lines.push(`To: ${email.to.map(mailboxLine).join(', ')}`);
    if (email.cc.length > 0) {
      lines.push(`Copy: ${email.cc.map(mailboxLine).join(', ')}`);
    }
    if (email.bcc.length > 0) {
      lines.push(`Hidden copy: ${email.bcc.map(mailboxLine).join(', ')}`);
    }
    if (email.from_name !== null && email.from_name !== undefined) {
      lines.push(`Sent as: ${email.from_name}`);
    }
    lines.push(`Subject: ${email.subject === '' ? 'No subject' : email.subject}`);
    if (email.name_left_off === true) {
      lines.push('The name was left off an address because it looked like an address.');
    }
    if (email.reply_to !== null) {
      lines.push(`Replies go to: ${email.reply_to}`);
    }
    if (email.replaces !== null) {
      lines.push(
        `Replaces the saved draft "${email.replaces.subject}" to ${email.replaces.to.map(mailboxLine).join(', ')}`,
      );
    }
    lines.push('Message body:');
    lines.push(email.body);
  }
  const event = card.calendar_event ?? null;
  if (event !== null) {
    if (event.before !== null) {
      lines.push('Now:');
      lines.push(`Title: ${event.before.title}`);
      lines.push(`When: ${event.before.when}`);
      if (event.before.duration !== '') {
        lines.push(`Length: ${event.before.duration}`);
      }
      if (event.before.location !== '') {
        lines.push(`Where: ${event.before.location}`);
      }
      lines.push('After the change:');
    } else {
      lines.push('Exactly what will be saved:');
    }
    lines.push(`Calendar: Main calendar of ${event.calendar}`);
    lines.push(`Title: ${event.title}`);
    lines.push(`When: ${event.when}`);
    lines.push(`Time zone: ${event.time_zone}`);
    lines.push(`Length: ${event.duration}`);
    if (event.location !== '') {
      lines.push(`Where: ${event.location}`);
    }
    if (event.already_created === true) {
      lines.push('You already have this event.');
    }
    if (event.span_days !== undefined && event.span_days > 1) {
      lines.push(`This event runs over ${String(event.span_days)} days.`);
    }
    if (event.one_of_repeating) {
      lines.push('Repeats: Only this one event of the series changes');
    }
    lines.push(`Guests: ${event.attendees.length === 0 ? 'None' : event.attendees.join(', ')}`);
    if (event.attendees.length > 0) {
      lines.push(
        event.guests_emailed
          ? 'Google will email every guest about this.'
          : 'Google will not email the guests about this.',
      );
    }
    if (event.description !== '') {
      lines.push('Description:');
      lines.push(event.description);
    }
  }
  const schedule = card.schedule ?? null;
  if (schedule !== null) {
    lines.push(`Name: ${schedule.name}`);
    lines.push(`When it runs: ${schedule.when} (${schedule.time_zone})`);
    lines.push(`Runs as: ${schedule.runs_as}`);
    if (schedule.action === 'create') {
      lines.push('Starts: As soon as you approve.');
    }
    if (schedule.next_runs.length > 0) {
      lines.push('Next runs:');
      lines.push(...schedule.next_runs);
    }
    lines.push('What it will do each time:');
    lines.push(schedule.task);
  }
  const persona = card.persona ?? null;
  if (persona !== null) {
    lines.push(`Name: ${persona.name}`);
    lines.push(`For: ${persona.description}`);
    lines.push(`Answers with: ${persona.model_name}`);
    lines.push('Instructions:');
    lines.push(persona.instructions);
  }
  const skill = card.skill ?? null;
  if (skill !== null) {
    lines.push(`Name: ${skill.name}`);
    lines.push(`For: ${skill.description}`);
    lines.push(`From: ${skill.source}`);
    lines.push(`Version: ${skill.version}`);
    lines.push(
      skill.starter
        ? 'This is one of the starter skills that come with the app.'
        : 'This skill was written by someone else. Add it only if you trust where it comes from.',
    );
    lines.push('It may bring files and scripts along. Running code still asks you first, as always.');
    if (skill.instructions !== null) {
      lines.push('Instructions:');
      if (skillInstructionsCut(skill.instructions)) {
        lines.push(SKILL_INSTRUCTIONS_CUT_LINE);
        lines.push(skill.instructions.slice(0, TELEGRAM_SKILL_INSTRUCTIONS_CHARS));
      } else {
        lines.push(skill.instructions);
      }
    }
  }
  if (
    card.mail_new_recipients !== null &&
    card.mail_new_recipients !== undefined &&
    card.mail_new_recipients.length > 0
  ) {
    lines.push(`New email addresses: ${card.mail_new_recipients.join(', ')}`);
  }
  if (card.outbound_text !== null) {
    lines.push('Full request:');
    if (card.outbound_truncated) {
      lines.push('Part of this request is not shown in full.');
    }
    lines.push(card.outbound_text);
  }
  if (card.cannot_be_undone !== null) {
    lines.push(card.cannot_be_undone);
  }
  if (card.plain_why !== null) {
    lines.push(`Why: ${card.plain_why}`);
  }
  return lines;
}

const APP_ONLY_APPROVAL_LINE =
  'Aman needs your ok for an action, but Telegram cannot show everything it will do. Open Aman to see it and answer there.';
const TRUNCATED_APPROVAL_LINE =
  'Part of this action is not shown in full, so it cannot be approved from Telegram. Open Aman to see the whole thing and answer there.';

export interface TelegramApprovalPrompt {
  /** The text to send: the whole card, or the line that names the app when the card cannot be shown whole. */
  text: string;
  /**
   * True when the text shows everything the card shows, so Approve and Deny buttons may ride
   * it. False when the action has no card, the card carries a field Telegram does not show, or
   * part of it is cut: the message then carries no buttons and the person answers in the app.
   */
  complete: boolean;
  /**
   * The words on the allow button. "Approve" on most cards. On a card for email addresses that
   * are not on the person's send list yet, approving adds those addresses, so the button says
   * so instead. Only read when complete is true: an incomplete prompt carries no buttons.
   */
  approve_label: string;
}

/**
 * The allow button's words for one card, the same words the card in the app uses. A card for
 * new email addresses adds them when it is approved: "Add and send", or "Add and save draft"
 * when the card approves saving a draft and nothing is sent.
 */
function approveLabel(card: Tier3Card): string {
  if ((card.mail_new_recipients ?? []).length === 0) {
    return 'Approve';
  }
  return card.mail_draft === true ? 'Add and save draft' : 'Add and send';
}

/** The Telegram form of one approval ask: the whole card, and whether buttons may ride it. */
export function approvalPrompt(action: ActionRequiredEvent, toolCallId: string): TelegramApprovalPrompt | undefined {
  if (action.type !== 'tool.approval_required') {
    return undefined;
  }
  const call = action.tool_calls.find(candidate => candidate.id === toolCallId);
  if (call === undefined) {
    return undefined;
  }
  const card = call.tier3_card ?? null;
  if (card === null) {
    return { text: APP_ONLY_APPROVAL_LINE, complete: false, approve_label: 'Approve' };
  }
  if (cardHasUnshownField(card)) {
    return { text: APP_ONLY_APPROVAL_LINE, complete: false, approve_label: 'Approve' };
  }
  const lines = approvalCardLines(card);
  if (cardIsCut(card)) {
    lines.push(TRUNCATED_APPROVAL_LINE);
    return { text: lines.join('\n'), complete: false, approve_label: approveLabel(card) };
  }
  return { text: lines.join('\n'), complete: true, approve_label: approveLabel(card) };
}

async function deliverOne(deps: TelegramReplyDeps, reply: TelegramPendingReply): Promise<void> {
  const connection: TelegramConnection | undefined = await deps.store.getConnectionById({ id: reply.connection_id });
  if (connection === undefined) {
    await deps.store.deletePendingReply({ id: reply.id });
    return;
  }
  const turn = await deps.sessionStore.getTurn({ session_id: reply.session_id, turn_id: reply.turn_id });
  if (turn === undefined) {
    await deps.store.deletePendingReply({ id: reply.id });
    return;
  }
  if (turn.state.status === 'running') {
    return;
  }
  // The turn is finished, so this pass is committed to sending: clear the debt now, before any
  // send goes out, so a crash from here on can never make the next pass send the answer again.
  await deps.store.deletePendingReply({ id: reply.id });
  const client = deps.service.clientFor(connection);
  const owner = { tenant_id: reply.tenant_id, created_by: reply.created_by };
  const send = async (text: string, buttons?: readonly (readonly { text: string; callback_data: string }[])[]) => {
    try {
      await sendTelegramText({ queue: deps.queue, client, chat_id: reply.chat_id, text, inline_buttons: buttons });
    } catch (error) {
      // One attempt is all a send gets; the answer stays in the app.
      deps.logger.warn('A Telegram reply could not be sent', {
        connection_id: connection.id,
        turn_id: reply.turn_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (turn.state.status === 'done') {
    const text = modelMessageText(turn.state.output);
    if (text !== undefined) {
      await send(text);
    }
    let appOnly = false;
    for (const action of turn.state.required_actions) {
      if (action.type !== 'tool.approval_required') {
        appOnly = true;
        continue;
      }
      for (const call of action.tool_calls) {
        const prompt = approvalPrompt(action, call.id);
        if (prompt === undefined) {
          continue;
        }
        if (!prompt.complete) {
          // Telegram cannot show this action whole, so it gets no buttons and no row for a
          // button to point at: the ask is named, and the app is where it is answered.
          await send(prompt.text);
          continue;
        }
        const pending = await deps.store.addPendingApproval({
          ...owner,
          connection_id: connection.id,
          session_id: reply.session_id,
          turn_id: reply.turn_id,
          thread_id: action.thread_id,
          tool_call_id: call.id,
          chat_id: reply.chat_id,
          prompt: prompt.text,
          expires_at: call.expires_at ?? null,
        });
        await send(prompt.text, [
          [
            {
              text: prompt.approve_label,
              callback_data: telegramCallbackData({ decision: 'allow', approval_id: pending.id }),
            },
            { text: 'Deny', callback_data: telegramCallbackData({ decision: 'deny', approval_id: pending.id }) },
          ],
        ]);
      }
    }
    if (appOnly) {
      await send(APP_ONLY_LINE);
    }
  } else if (turn.state.status === 'error') {
    await send(TURN_ERROR_LINE);
  } else {
    await send(TURN_CANCELLED_LINE);
  }
}

/** One pass over the replies Telegram is owed. A failure on one never stops the rest. */
export async function deliverPendingTelegramReplies(deps: TelegramReplyDeps): Promise<void> {
  const replies = await deps.store.listPendingReplies({ limit: TELEGRAM_PENDING_REPLY_BATCH });
  for (const reply of replies) {
    try {
      await deliverOne(deps, reply);
    } catch (error) {
      deps.logger.warn('A Telegram reply could not be delivered', {
        reply_id: reply.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
