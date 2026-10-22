import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { describe, expect, it } from 'vitest';

import { answersBriefPrompt, messageText } from '@/containers/briefTurn.js';

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

  it('is false for an answer to any other request, or the first message', () => {
    expect(answersBriefPrompt([user('u1', 'What is on today?'), assistant('a1')], 'a1')).toBe(false);
    expect(answersBriefPrompt([assistant('a1')], 'a1')).toBe(false);
  });

  it('is false when the message is not found', () => {
    expect(answersBriefPrompt([user('u1', MORNING_BRIEF_PROMPT)], 'missing')).toBe(false);
  });
});
