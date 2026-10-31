import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { SANDBOX_MCP_SERVER_ID } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import {
  finalAnswerStream,
  makeMockIMCPServer,
  makeSilentLogger,
  OBJECT_INPUT_SCHEMA,
  unknownToolStream,
} from '../harnessMocks';

const CLONE = 'git clone --branch main https://github.com/ClimbOutLabs/exitramp.git exitramp';

describe('a shell command sent to run_code', () => {
  it('tells the model to use the shell tool and logs the stopped call without its values', async () => {
    const toolSet = makeMockIMCPServer({
      name: SANDBOX_MCP_SERVER_ID,
      preload: true,
      tools: [
        { name: 'exec', description: 'Run a shell command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
        {
          name: 'run_code',
          description: 'Run Python or Node code',
          inputSchema: {
            type: 'object',
            properties: { language: { type: 'string', enum: ['python', 'node'] }, code: { type: 'string' } },
            required: ['language'],
          },
          preload: true,
        },
      ],
    });
    jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: 'run_code',
      is_approval_required: false,
    });
    jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'ok' }));
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return requests.length === 1
        ? unknownToolStream({
            toolName: 'run_code',
            callId: 'call_clone',
            args: JSON.stringify({ language: 'bash', code: CLONE }),
          })
        : finalAnswerStream('I will use the shell.');
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const logger = makeSilentLogger();
    const warn = jest.spyOn(logger, 'warn');
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger,
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Clone the exitramp repo.' }],
    });
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      void event;
    }

    expect(toolSet.callTool).not.toHaveBeenCalled();
    const retryText = JSON.stringify(requests[1]?.messages);
    expect(retryText).toContain('runs only Python or Node code and this is a shell command');
    expect(retryText).toContain('Call the exec tool instead, with the same shell command in its command field.');
    expect(retryText).not.toContain('some of its arguments were wrong');

    expect(warn).toHaveBeenCalledWith('Reply guard stopped a tool call before it ran', {
      threadId: 'main',
      tool: 'run_code',
      toolCallId: 'call_clone',
      argumentKeys: ['language', 'code'],
      reason: 'shell_command_in_run_code',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('exitramp.git');
  });
});
