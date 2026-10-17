import type { InternalEnrichedAssistantMessage } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

function call(name: string): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `${name}-call`,
        type: 'function',
        function: { name, arguments: '{}' },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'mail',
          mcp_server_name: 'mail',
          original_tool_name: name,
          is_approval_required: false,
          read_only_hint: true,
        },
      },
    ],
  };
}

function returning(content: unknown[]): IToolSet {
  const base = toolResultResponse({ text: '' });
  return {
    name: 'mail',
    id: 'mail',
    preload: true,
    hasPreloadedTools: true,
    listTools: jest.fn(),
    toolCallInfo: jest.fn(),
    callTool: jest.fn(() => Promise.resolve({ ...base, result: { content } })),
  };
}

async function run(content: unknown[]) {
  const result = await executeToolCalls({
    assistantMessage: call('download_attachment'),
    toolMapping: new Map([['download_attachment', { toolSet: returning(content), originalToolName: 'download_attachment' }]]),
    threadId: 'main',
    approvalDecisions: new Map(),
    memoState: createToolCallMemoState(),
  });
  const first = result.toolCallResults[0];
  if (first === undefined) {
    throw new Error('expected one tool result');
  }
  return first;
}

describe('tool result images', () => {
  it('sets image blocks aside for the host and keeps them out of the model text', async () => {
    const result = await run([
      { type: 'text', text: 'Attachment downloaded: photo.png' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ]);
    expect(result.images).toEqual([{ mime: 'image/png', data: Buffer.from(PNG_BASE64, 'base64') }]);
    expect(result.message.content).not.toContain(PNG_BASE64);
    expect(result.rawContent).not.toContain(PNG_BASE64);
  });

  it('never puts image bytes in the text of an image-only result', async () => {
    const result = await run([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }]);
    expect(result.message.content).not.toContain(PNG_BASE64);
    expect(result.images).toHaveLength(1);
  });

  it('skips malformed image blocks', async () => {
    const result = await run([
      { type: 'text', text: 'ok' },
      { type: 'image', data: 42, mimeType: 'image/png' },
      { type: 'image', data: PNG_BASE64 },
    ]);
    expect(result.images).toEqual([]);
  });
});
