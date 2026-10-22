import { describe, expect, it } from 'vitest';

import {
  approvalSpeechLine,
  finalAnswerSpeech,
  limitSpeechWords,
  pendingApprovalCallIds,
  plainSpeechText,
} from '@/utils/speechText.js';

describe('plainSpeechText', () => {
  it('drops code blocks, tables, rules and URLs and keeps the words of links and code', () => {
    const markdown = [
      '# Plan',
      '',
      'Use **bold** and _soft_ words, see [the guide](https://example.com/guide) or https://example.com/raw.',
      '',
      '```ts',
      'const secret = 1;',
      '```',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '- first item',
      '1. second item',
      '> quoted line',
      '',
      '---',
      'Run `pnpm test` now.',
    ].join('\n');

    expect(plainSpeechText(markdown)).toBe(
      'Plan Use bold and soft words, see the guide or first item second item quoted line Run pnpm test now.',
    );
  });

  it('keeps underscores inside words and drops image markup', () => {
    expect(plainSpeechText('Open file_name.md ![chart](https://x.test/c.png) today')).toBe('Open file_name.md today');
  });
});

describe('limitSpeechWords', () => {
  it('reads a short answer in full', () => {
    expect(limitSpeechWords('Three words here.')).toBe('Three words here.');
  });

  it('reads the first 60 words and then says where the rest is', () => {
    const words = Array.from({ length: 100 }, (_, index) => `w${String(index)}`);
    const spoken = limitSpeechWords(words.join(' '));
    expect(spoken).toBe(`${words.slice(0, 60).join(' ')}. The rest is on screen.`);
  });

  it('does not add a second full stop when the cut lands on a sentence end', () => {
    const head = Array.from({ length: 59 }, (_, index) => `w${String(index)}`).join(' ');
    expect(limitSpeechWords(`${head} done. More words follow after that point.`)).toBe(
      `${head} done. The rest is on screen.`,
    );
  });
});

describe('finalAnswerSpeech', () => {
  it('reads only the text after the last tool call, not status text before it', () => {
    const content = [
      { type: 'text', text: 'Checking your calendar now.' },
      { type: 'tool-call', toolCallId: 'call-1' },
      { type: 'text', text: 'You have **two** meetings' },
      { type: 'text', text: 'tomorrow.' },
    ];
    expect(finalAnswerSpeech(content)).toBe('You have two meetings tomorrow.');
  });

  it('is empty when the message ends on a tool call', () => {
    expect(
      finalAnswerSpeech([
        { type: 'text', text: 'Looking' },
        { type: 'tool-call', toolCallId: 'call-2' },
      ]),
    ).toBe('');
  });
});

describe('pendingApprovalCallIds', () => {
  it('lists only tool calls still waiting for a decision', () => {
    const content = [
      { type: 'tool-call', toolCallId: 'waiting', approval: { id: 'a1' } },
      { type: 'tool-call', toolCallId: 'approved', approval: { id: 'a2', approved: true } },
      { type: 'tool-call', toolCallId: 'resolved', approval: { id: 'a3', resolution: 'denied' } },
      { type: 'tool-call', toolCallId: 'plain' },
    ];
    expect(pendingApprovalCallIds(content)).toEqual(['waiting']);
  });
});

describe('approvalSpeechLine', () => {
  it('builds one short line from the card sentence', () => {
    expect(approvalSpeechLine('Send the email to Sam Rivera.')).toBe(
      'I need your OK on screen. Send the email to Sam Rivera.',
    );
  });

  it('falls back to the plain request when the card has no sentence', () => {
    expect(approvalSpeechLine('')).toBe('I need your OK on screen.');
  });
});
