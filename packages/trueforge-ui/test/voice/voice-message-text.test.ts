// @vitest-environment jsdom
import type { ThreadAssistantMessagePart } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';

import { messageTextOf } from '@/voice/messageText.js';

const text = (value: string): ThreadAssistantMessagePart => ({ type: 'text', text: value });

describe('messageTextOf', () => {
  it('joins text parts with blank lines', () => {
    expect(messageTextOf([text('Hello'), text('World')])).toBe('Hello\n\nWorld');
  });

  it('skips whitespace-only text parts', () => {
    expect(messageTextOf([text('   '), text('kept')])).toBe('kept');
  });

  it('never surfaces internal reasoning', () => {
    expect(messageTextOf([{ type: 'reasoning', text: 'thinking' }, text('answer')])).toBe('answer');
  });

  it('renders image and file parts as marker lines', () => {
    expect(messageTextOf([{ type: 'image', image: 'data:image/png;base64,x' }])).toBe('[image]');
    expect(messageTextOf([{ type: 'file', data: 'x', mimeType: 'text/plain' }])).toBe('[file]');
  });

  it('renders tool calls as a readable marker with the tool name', () => {
    expect(
      messageTextOf([
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName: 'search',
          args: {},
          argsText: '{}',
          result: undefined,
        },
      ]),
    ).toBe('[tool: search]');
  });

  it('renders source parts with title, falling back to url', () => {
    expect(messageTextOf([{ type: 'source', sourceType: 'url', id: '1', url: 'https://x', title: 'X' }])).toBe(
      '[source: X]',
    );
    expect(messageTextOf([{ type: 'source', sourceType: 'url', id: '1', url: 'https://x' }])).toBe(
      '[source: https://x]',
    );
  });

  it('renders data and generative UI parts as markers', () => {
    expect(messageTextOf([{ type: 'data', name: 'chart', data: {} }])).toBe('[data]');
    expect(messageTextOf([{ type: 'generative-ui', spec: { root: 'hi' } }])).toBe('[generated content]');
  });

  it('returns an empty string when there is nothing readable', () => {
    expect(messageTextOf([])).toBe('');
    expect(messageTextOf([{ type: 'reasoning', text: 'only thinking' }])).toBe('');
  });
});
