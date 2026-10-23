import { apiErrorCode } from './apiErrorCode.js';

/** A message or approval answer the server refused (409) before recording anything. */
export type TurnRefusalCode = 'previous_turn_running' | 'turn_could_not_start';

/** Why a chat's last send did not get a reply: refused by the server, or stopped by a server restart. */
export type SendRefusal = TurnRefusalCode | 'stopped_by_restart';

export function turnRefusalCode(error: unknown): TurnRefusalCode | undefined {
  const detail = apiErrorCode(error);
  if (detail?.statusCode !== 409) return undefined;
  if (detail.code === 'previous_turn_running') return 'previous_turn_running';
  if (detail.code === 'turn_could_not_start') return 'turn_could_not_start';
  return undefined;
}

/** What the chat says when a new message or answer waits on a reply that is still running. */
function stillWorkingText(assistantName: string): string {
  return `${assistantName} is still working on your last message. Wait for it to finish, or press Cancel, then send again.`;
}

/** Plain words for a send that got no reply. The server's own text is never shown for these. */
export function sendRefusalText({ refusal, assistantName }: { refusal: SendRefusal; assistantName: string }): string {
  switch (refusal) {
    case 'previous_turn_running':
      return stillWorkingText(assistantName);
    case 'turn_could_not_start':
      return 'That reply could not start. Send your message again.';
    case 'stopped_by_restart':
      return `This reply stopped when ${assistantName} restarted. Send your message again.`;
  }
}

/** Plain words for an approval answer the server refused; nothing was recorded, so the buttons stay. */
export function answerRefusalText({ code, assistantName }: { code: TurnRefusalCode; assistantName: string }): string {
  switch (code) {
    case 'previous_turn_running':
      return stillWorkingText(assistantName);
    case 'turn_could_not_start':
      return 'That reply could not start, so nothing was done. Answer again.';
  }
}
