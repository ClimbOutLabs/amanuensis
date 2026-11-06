import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { ActionRequiredEvent, ModelMessageEvent } from '@truefoundry/trueforge-core/core/events/schema';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { ITelegramStore, TelegramConnection, TelegramPendingReply } from '../../db/telegramStore';
import { telegramCallbackData } from './telegramChannel';
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

/** The plain-words text of one approval ask, from the card the app would show. */
export function approvalPromptText(action: ActionRequiredEvent, toolCallId: string): string | undefined {
  if (action.type !== 'tool.approval_required') {
    return undefined;
  }
  const call = action.tool_calls.find(candidate => candidate.id === toolCallId);
  if (call === undefined) {
    return undefined;
  }
  const card = call.tier3_card ?? null;
  const lines: string[] = [card?.plain_what ?? 'Aman needs your ok to go on.'];
  if (card !== null) {
    if (card.plain_why !== null) {
      lines.push(card.plain_why);
    }
    if (card.destination !== null) {
      lines.push(`Where: ${card.destination}`);
    }
    if (card.recipient !== null) {
      lines.push(`To: ${card.recipient}`);
    }
    if (card.amount !== null) {
      lines.push(`Amount: ${card.amount}`);
    }
    if (card.cannot_be_undone !== null) {
      lines.push(card.cannot_be_undone);
    }
  }
  return lines.join('\n');
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
        const prompt = approvalPromptText(action, call.id);
        if (prompt === undefined) {
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
          prompt,
          expires_at: call.expires_at ?? null,
        });
        await send(prompt, [
          [
            { text: 'Approve', callback_data: telegramCallbackData({ decision: 'allow', approval_id: pending.id }) },
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
