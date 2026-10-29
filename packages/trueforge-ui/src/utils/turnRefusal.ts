import { apiErrorCode } from './apiErrorCode.js';

/** A message or approval answer the server refused (409) before recording anything. */
export type TurnRefusalCode = 'previous_turn_running' | 'turn_could_not_start';

/** Skills left out of a chat's sends: the sandbox is not ready, or this chat has it turned off. */
export type SkillsNotice = 'skills_off_without_sandbox' | 'skills_off_sandbox_turned_off';

export function isSkillsNotice(kind: SendRefusal): kind is SkillsNotice {
  return kind === 'skills_off_without_sandbox' || kind === 'skills_off_sandbox_turned_off';
}

/** What the chat tells about its last send: refused by the server, stopped by a restart, or sent without skills. */
export type SendRefusal = TurnRefusalCode | 'stopped_by_restart' | SkillsNotice;

export function turnRefusalCode(error: unknown): TurnRefusalCode | undefined {
  const detail = apiErrorCode(error);
  if (detail?.statusCode !== 409) return undefined;
  if (detail.code === 'previous_turn_running') return 'previous_turn_running';
  if (detail.code === 'turn_could_not_start') return 'turn_could_not_start';
  return undefined;
}

/** Why a saved turn that was cancelled got no reply, when the person should be told. */
export function cancelledTurnRefusal(reason: string): SendRefusal | undefined {
  if (reason === 'abandoned') return 'stopped_by_restart';
  if (reason === 'could-not-start') return 'turn_could_not_start';
  return undefined;
}

/** What the chat says when a new message or answer waits on a reply that is still running. */
function stillWorkingText(assistantName: string): string {
  return `${assistantName} is still working on your last message. Wait for it to finish, or press Stop, then send again.`;
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
    case 'skills_off_without_sandbox':
      return 'Skills are off for this chat because the space they run in is not ready yet.';
    case 'skills_off_sandbox_turned_off':
      return 'Skills are off for this chat because the space they run in is turned off for it. Turn it on to use skills.';
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
