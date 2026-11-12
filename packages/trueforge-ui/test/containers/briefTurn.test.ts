import {
  MORNING_BRIEF_CARD_PROMPT,
  MORNING_BRIEF_PROMPT,
} from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { describe, expect, it } from 'vitest';

import { answersBriefPrompt, briefRequestDate, messageText } from '@/containers/briefTurn.js';

const user = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }] });
const assistant = (id: string) => ({ id, role: 'assistant', content: [{ type: 'text', text: 'Answer' }] });

describe('messageText', () => {
  it('joins the text parts in order and skips other parts', () => {
    expect(messageText([{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }])).toBe(
      'one\ntwo',
    );
  });
});

describe('answersBriefPrompt', () => {
  it('is true for an answer right after a morning brief request', () => {
    const messages = [user('u1', MORNING_BRIEF_PROMPT), assistant('a1')];
    expect(answersBriefPrompt(messages, 'a1')).toBe(true);
  });

  it('is true for an answer right after the brief card prompt, which shares the opening', () => {
    const messages = [user('u1', MORNING_BRIEF_CARD_PROMPT), assistant('a1')];
    expect(answersBriefPrompt(messages, 'a1')).toBe(true);
  });

  it('is false for an answer to any other request, or the first message', () => {
    expect(answersBriefPrompt([user('u1', 'What is on today?'), assistant('a1')], 'a1')).toBe(false);
    expect(answersBriefPrompt([assistant('a1')], 'a1')).toBe(false);
  });

  it('is false when the message is not found', () => {
    expect(answersBriefPrompt([user('u1', MORNING_BRIEF_PROMPT)], 'missing')).toBe(false);
  });
});

describe('briefRequestDate', () => {
  it('gives the day of the first brief request in the thread, and null for other chats', () => {
    const when = new Date(2026, 9, 20, 7, 30);
    const withBrief = [
      { ...user('u1', MORNING_BRIEF_PROMPT), createdAt: when },
      { ...assistant('a1'), createdAt: new Date(2026, 9, 20, 7, 31) },
    ];
    expect(briefRequestDate(withBrief)).toBe(when);
    expect(briefRequestDate([{ ...user('u2', 'Plan my week'), createdAt: when }])).toBeNull();
  });

  it('gives the day of a brief started from the home card', () => {
    const when = new Date(2026, 9, 21, 7, 5);
    const fromCard = [{ ...user('u1', MORNING_BRIEF_CARD_PROMPT), createdAt: when }];
    expect(briefRequestDate(fromCard)).toBe(when);
  });
});
