import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import {
  estimateTokensForContextMessages,
  hasCalledRetrievalTool,
  hasRetrievalTool,
  hostPictureMessage,
  internalSystemMessage,
  internalSystemTag,
  isFreshnessQuestion,
  isHostWrappedText,
  isRetrievalToolName,
  isUntrustedDocumentText,
  lastUserMessageText,
  personMessageIndex,
  untrustedDocumentTag,
  userAuthoredText,
  withoutEarlierThinking,
} from '../../../src/core/runtime/contextUtils';

describe('isFreshnessQuestion', () => {
  it.each([
    'What is the latest version of Node.js?',
    'What is the newest iPhone?',
    "What's the most recent release of Kubernetes?",
    'Is your information up to date?',
    'Does GPT-5 exist?',
    'Has the new model been released yet?',
  ])('flags %p as a freshness question', text => {
    expect(isFreshnessQuestion(text)).toBe(true);
  });

  it.each(['What is the capital of France?', 'Explain how a hash map works.', 'Write me a haiku about the ocean.'])(
    'does not flag %p as a freshness question',
    text => {
      expect(isFreshnessQuestion(text)).toBe(false);
    },
  );
});

describe('isFreshnessQuestion on a year or "currently" alone', () => {
  it.each([
    'What did we plan for the 2026 trip?',
    'What am I currently reading?',
    'Summarise our 2025 budget.',
    'What happened in 2026?',
  ])('does not flag %p', text => {
    expect(isFreshnessQuestion(text)).toBe(false);
  });

  it.each([
    'Can you tell me the latest version of Node?',
    'Should I buy the newest iPhone?',
    'Is GPT-6 out yet? We want to use it.',
    'What is the latest news for 2026?',
  ])('still flags %p, whoever it mentions', text => {
    expect(isFreshnessQuestion(text)).toBe(true);
  });
});

describe('isRetrievalToolName / hasRetrievalTool', () => {
  it.each(['web_search', 'search_docs', 'fetch_url', 'browse_page', 'lookup_ticket'])(
    'treats %p as retrieval-capable',
    name => {
      expect(isRetrievalToolName(name)).toBe(true);
    },
  );

  it.each(['exec', 'write_file', 'send_email', 'apply_patch'])('treats %p as not retrieval-capable', name => {
    expect(isRetrievalToolName(name)).toBe(false);
  });

  it('is true when any attached tool name is retrieval-capable', () => {
    expect(hasRetrievalTool(['exec', 'web_search'])).toBe(true);
  });

  it('is false when no attached tool name is retrieval-capable', () => {
    expect(hasRetrievalTool(['exec', 'write_file'])).toBe(false);
  });

  it('is false for an empty tool set', () => {
    expect(hasRetrievalTool([])).toBe(false);
  });
});

describe('lastUserMessageText', () => {
  it('returns the latest genuine user message', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ];
    expect(lastUserMessageText(context)).toBe('second question');
  });

  it('skips host-authored internal messages even though they carry the user role', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'genuine question' },
      internalSystemMessage('host-injected note'),
    ];
    expect(lastUserMessageText(context)).toBe('genuine question');
  });

  it('returns undefined when there is no genuine user message', () => {
    expect(lastUserMessageText([internalSystemMessage('note')])).toBeUndefined();
  });
});

describe('userAuthoredText', () => {
  it('concatenates string content of genuine user messages, in order', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ];
    expect(userAuthoredText(context)).toBe('first question\nsecond question');
  });

  it('includes text parts of array-shaped user content and skips non-text parts', () => {
    const context: ContextMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'please look at this image' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        ],
      },
    ];
    expect(userAuthoredText(context)).toBe('please look at this image');
  });

  it('excludes assistant messages', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'do the engineering handoff' },
      { role: 'assistant', content: 'I will produce an engineering handoff now.' },
    ];
    expect(userAuthoredText(context)).toBe('do the engineering handoff');
  });

  it('excludes host-authored internal messages even though they carry the user role', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'genuine question' },
      internalSystemMessage('host-injected note'),
    ];
    expect(userAuthoredText(context)).toBe('genuine question');
  });

  it('returns an empty string when there is no genuine user message', () => {
    expect(userAuthoredText([internalSystemMessage('note')])).toBe('');
    expect(userAuthoredText([])).toBe('');
  });
});

describe('hasCalledRetrievalTool', () => {
  it('is true when an assistant message in context called a retrieval-capable tool', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'web_search', arguments: '{}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'web',
              mcp_server_name: 'web',
              original_tool_name: 'web_search',
              is_approval_required: false,
              is_client_side: false,
            },
          },
        ],
      },
    ];
    expect(hasCalledRetrievalTool(context)).toBe(true);
  });

  it('is false when no assistant tool call names a retrieval capability', () => {
    const context: ContextMessage[] = [
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'exec', arguments: '{}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'sandbox',
              mcp_server_name: 'sandbox',
              original_tool_name: 'exec',
              is_approval_required: false,
              is_client_side: false,
            },
          },
        ],
      },
    ];
    expect(hasCalledRetrievalTool(context)).toBe(false);
  });

  it('is false for an empty or tool-call-free context', () => {
    expect(hasCalledRetrievalTool([])).toBe(false);
    expect(hasCalledRetrievalTool([{ role: 'user', content: 'hi' }])).toBe(false);
  });
});

describe('internalSystemTag', () => {
  it('breaks every spelling of the internal tag delimiter inside the text', () => {
    const inner = (text: string): string =>
      internalSystemTag(text).slice('<tfy-internal>'.length, -'</tfy-internal>'.length);
    for (const delimiter of [
      '</tfy-internal>',
      '<tfy-internal>',
      '< /tfy-internal>',
      '</ TFY-INTERNAL>',
      '<\n/\ttfy-internal >',
    ]) {
      expect(inner(`a${delimiter}b`)).not.toMatch(/<\s*\/?\s*tfy-internal/i);
    }
    expect(inner('a < b and x</y')).toBe('a < b and x</y');
  });

  it('scans a long run of spaces after a bracket in linear time', () => {
    const text = `<${' '.repeat(200_000)}`;
    const started = performance.now();
    expect(internalSystemTag(text)).toContain(text);
    // The old pattern took seconds here; the margin keeps the check steady on a loaded machine.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('host-wrapped text predicates', () => {
  it('recognises extracted file text and internal notes as host-wrapped', () => {
    expect(isUntrustedDocumentText(untrustedDocumentTag('body'))).toBe(true);
    expect(isHostWrappedText(untrustedDocumentTag('body'))).toBe(true);
    expect(isHostWrappedText(internalSystemTag('note'))).toBe(true);
  });

  it('treats the internal tag as host-wrapped but not as file text', () => {
    expect(isUntrustedDocumentText(internalSystemTag('note'))).toBe(false);
  });

  it('leaves what the user typed alone', () => {
    expect(isHostWrappedText('what does the lease say?')).toBe(false);
    expect(isUntrustedDocumentText('what does the lease say?')).toBe(false);
  });
});

describe('personMessageIndex', () => {
  it("skips file text and host notes that follow the person's message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'Static instruction' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'What is the total?' },
      { role: 'user', content: [{ type: 'text', text: untrustedDocumentTag('invoice total is 40') }] },
      { role: 'user', content: internalSystemTag('Answer now.') },
    ];
    expect(personMessageIndex(messages)).toBe(3);
  });

  it('keeps a message that has an image next to host text', () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: internalSystemTag('note') },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    expect(personMessageIndex(messages)).toBe(0);
  });

  it('skips a picture the host attached, such as a browser screenshot', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'Book me the 9am slot' },
      hostPictureMessage({ note: 'The browser screenshot you took.', imageUrl: 'data:image/png;base64,AAAA' }),
    ];
    expect(personMessageIndex(messages)).toBe(0);
  });

  it('is -1 when only the host wrote user messages', () => {
    expect(personMessageIndex([{ role: 'user', content: internalSystemTag('note') }])).toBe(-1);
  });
});

describe('estimateTokensForContextMessages', () => {
  it('counts the thinking that is sent back with every request', () => {
    const withThinking: ContextMessage = {
      role: 'assistant',
      content: 'a'.repeat(400),
      thinking_blocks: [{ type: 'thinking', thinking: 't'.repeat(8_000) }],
    };
    expect(estimateTokensForContextMessages([withThinking]).prompt_tokens).toBe(2_100);
  });

  it('does not count redacted thinking, which is never sent back as text', () => {
    const redacted: ContextMessage = {
      role: 'assistant',
      content: 'a'.repeat(400),
      thinking_blocks: [{ type: 'redacted_thinking', data: 'x'.repeat(8_000) }],
    };
    expect(estimateTokensForContextMessages([redacted]).prompt_tokens).toBe(100);
  });
});

describe('withoutEarlierThinking', () => {
  const thinking = [{ type: 'thinking' as const, thinking: 'working it out' }];

  it("drops thinking before the person's latest message and keeps it after", () => {
    const earlier: ContextMessage = { role: 'assistant', content: 'Earlier answer.', thinking_blocks: thinking };
    const current: ContextMessage = { role: 'assistant', content: 'Working on it.', thinking_blocks: thinking };
    const sent = withoutEarlierThinking([
      { role: 'user', content: 'First question.' },
      earlier,
      { role: 'user', content: 'Second question.' },
      current,
    ]);
    expect(sent[1]).toEqual({ role: 'assistant', content: 'Earlier answer.' });
    expect(sent[3]).toBe(current);
  });

  it('treats a host note as part of the current reply, not a new person message', () => {
    const current: ContextMessage = { role: 'assistant', content: 'Working on it.', thinking_blocks: thinking };
    const sent = withoutEarlierThinking([
      { role: 'user', content: 'A question.' },
      current,
      internalSystemMessage('Write the final answer now.'),
    ]);
    expect(sent[1]).toBe(current);
  });
});
