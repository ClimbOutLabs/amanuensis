import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { EventType, type AgentInputUserMessage } from '@truefoundry/trueforge-core/core';

import { extractUserMessageText } from '../../../src/runtime/userMessageText';

describe('extractUserMessageText', () => {
  function userMessage(content: AgentInputUserMessage['content']): TurnInputItem {
    return { type: EventType.USER_MESSAGE, content };
  }

  const toolResponseItem: TurnInputItem = {
    type: EventType.USER_TOOL_RESPONSE,
    thread_id: 't1',
    tool_call_id: 'c1',
    content: 'ignored',
  };

  it('returns an empty string for undefined or empty input', () => {
    expect(extractUserMessageText(undefined)).toBe('');
    expect(extractUserMessageText([])).toBe('');
  });

  it('returns a single user message text unchanged', () => {
    const input = [userMessage('hello there')];
    expect(extractUserMessageText(input)).toBe('hello there');
  });

  it('concatenates every user message in order, joined by a blank line', () => {
    const input = [userMessage('first message'), toolResponseItem, userMessage('second message')];
    expect(extractUserMessageText(input)).toBe('first message\n\nsecond message');
  });

  it('excludes file parts from structured content while keeping text parts, across multiple messages', () => {
    const input = [
      userMessage([
        { type: 'text', text: 'see attached' },
        { type: 'file', name: 'report.pdf', data: 'data:application/pdf;base64,AAAA' },
      ]),
      userMessage([{ type: 'text', text: 'and this too' }]),
    ];
    expect(extractUserMessageText(input)).toBe('see attached\n\nand this too');
  });

  it('ignores non-user-message input items entirely', () => {
    expect(extractUserMessageText([toolResponseItem])).toBe('');
  });

  it("drops text the host wrote into the message, keeping only the person's words", () => {
    const input = [
      userMessage([
        { type: 'text', text: '<tfy-internal>Personalization: likes tea.</tfy-internal>' },
        { type: 'text', text: 'I moved to Porto.' },
        { type: 'text', text: '<untrusted-document>extracted file text</untrusted-document>' },
      ]),
    ];
    expect(extractUserMessageText(input)).toBe('I moved to Porto.');
  });

  it('excludes a name carried in a tool result, feeding the profile learner only the user turn', () => {
    const toolResponseWithName: TurnInputItem = {
      type: EventType.USER_TOOL_RESPONSE,
      thread_id: 't1',
      tool_call_id: 'c1',
      content: 'Prepared for: Aman (QA tester).',
    };
    const input = [userMessage('what is my name?'), toolResponseWithName];
    expect(extractUserMessageText(input)).toBe('what is my name?');
  });
});
