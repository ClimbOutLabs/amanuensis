import { describe, expect, it } from 'vitest';

import {
  answerRefusalText,
  sendRefusalText,
  turnRefusalCode,
  type SendRefusal,
  type TurnRefusalCode,
} from '@/utils/turnRefusal.js';

function conflict(code: string, statusCode = 409) {
  return Object.assign(new Error('Previous turn 01m5 is still running'), {
    statusCode,
    body: { error: { message: 'Previous turn 01m5 is still running', type: 'conflict', code } },
  });
}

describe('turnRefusalCode', () => {
  it('reads the two refusals that recorded nothing', () => {
    expect(turnRefusalCode(conflict('previous_turn_running'))).toBe('previous_turn_running');
    expect(turnRefusalCode(conflict('turn_could_not_start'))).toBe('turn_could_not_start');
  });

  it('ignores other conflicts, other statuses and plain errors', () => {
    expect(turnRefusalCode(conflict('held_action_expired'))).toBeUndefined();
    expect(turnRefusalCode(conflict('previous_turn_running', 500))).toBeUndefined();
    expect(turnRefusalCode(new Error('network down'))).toBeUndefined();
  });
});

const sendLines: Array<[SendRefusal, string]> = [
  [
    'previous_turn_running',
    'Juniper is still working on your last message. Wait for it to finish, or press Stop, then send again.',
  ],
  ['turn_could_not_start', 'That reply could not start. Send your message again.'],
  ['stopped_by_restart', 'This reply stopped when Juniper restarted. Send your message again.'],
];

const answerLines: Array<[TurnRefusalCode, string]> = [
  [
    'previous_turn_running',
    'Juniper is still working on your last message. Wait for it to finish, or press Stop, then send again.',
  ],
  ['turn_could_not_start', 'That reply could not start, so nothing was done. Answer again.'],
];

describe('sendRefusalText', () => {
  it.each(sendLines)('says %s in plain words with the assistant name', (refusal, text) => {
    expect(sendRefusalText({ refusal, assistantName: 'Juniper' })).toBe(text);
  });
});

describe('answerRefusalText', () => {
  it.each(answerLines)('says %s on an approval answer in plain words', (code, text) => {
    expect(answerRefusalText({ code, assistantName: 'Juniper' })).toBe(text);
  });
});
