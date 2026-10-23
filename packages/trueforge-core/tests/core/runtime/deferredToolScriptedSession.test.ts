import { z } from 'zod';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { DeferredTool, LIST_TOOLS_NAME } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const silentLogger = makeSilentLogger();

async function listToolsText(deferredTool: DeferredTool, mcpServer: string): Promise<string> {
  const response = await deferredTool.callTool({ name: LIST_TOOLS_NAME, arguments: { mcp_server: mcpServer } });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved list_tools response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return first.text;
}

describe('DeferredTool scripted model session', () => {
  it('settles each call of the reported session: two unknown servers, then a real one', async () => {
    const server = makeMockIMCPServer({
      name: 'parallel-web',
      preload: false,
      tools: [
        { name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
        { name: 'fetch', description: 'fetch', inputSchema: OBJECT_INPUT_SCHEMA, preload: false },
      ],
    });
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const results = [
      await listToolsText(deferredTool, 'gmail'),
      await listToolsText(deferredTool, 'sub_agents'),
      await listToolsText(deferredTool, 'parallel-web'),
    ];

    const unknownServer = (name: string) =>
      JSON.stringify({
        error: `No server named '${name}'. Servers: parallel-web. No connector by that name is set up; the person can set one up in Settings, Connectors. Do not try other names; tell the person this. Built-in tools are called directly by name, never through call_tool; when one is not in your tool list, call load_bundle with its bundle first.`,
      });
    expect(results).toEqual([unknownServer('gmail'), unknownServer('sub_agents'), 'parallel-web:\n  search, fetch']);
  });

  it('returns an error, not a pending call, when a connector fails to list its tools', async () => {
    const server = {
      ...makeMockIMCPServer({ name: 'parallel-web', preload: false }),
      listTools: jest.fn(() => Promise.reject(new Error('upstream timed out'))),
    };
    const deferredTool = new DeferredTool([server], { tracing: NOOP_AGENT_TRACING, logger: silentLogger });

    const text = await listToolsText(deferredTool, 'parallel-web');

    expect(JSON.parse(text)).toEqual({
      error:
        'The parallel-web connector is set up but is not answering yet. Try again in a minute. Do not try other names; tell the person this if it keeps failing.',
      detail: 'upstream timed out',
    });
  });
});

/** The names the reported model tried, in order, while it looked for the person's mail. */
const GUESSES = ['email', 'gmail', 'inbox', 'outlook', 'mail'];

/**
 * A scripted model that keeps guessing server names until a result tells it to stop, then answers the
 * person with that result's line.
 */
async function guessingTurn(
  deferredTool: DeferredTool,
  guesses: readonly string[] = GUESSES,
): Promise<{ tried: string[]; answer: string }> {
  const tried: string[] = [];
  for (const name of guesses) {
    tried.push(name);
    const said = await listToolsText(deferredTool, name);
    const { error } = ErrorSchema.parse(JSON.parse(said));
    if (error.includes('Do not try other names')) {
      return { tried, answer: error };
    }
  }
  return { tried, answer: '' };
}

const ErrorSchema = z.object({ error: z.string() });

describe('DeferredTool when the connector the model wants is not in the chat', () => {
  const chatServers = () => [
    makeMockIMCPServer({ name: 'github', preload: false }),
    makeMockIMCPServer({ name: 'parallel-web', preload: false }),
  ];

  it('says the Email connector is not set up and where to set it up, and the model stops after one call', async () => {
    const deferredTool = new DeferredTool(chatServers(), {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      setUpConnectorNames: ['github', 'parallel-web'],
    });

    const { tried, answer } = await guessingTurn(deferredTool);

    expect(tried).toEqual(['email']);
    expect(answer).toContain('No connector by that name is set up; the person can set one up in Settings, Connectors.');
  });

  it('says the Email connector is turned off for this chat and where to turn it on', async () => {
    const deferredTool = new DeferredTool(chatServers(), {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      setUpConnectorNames: ['github', 'parallel-web', 'Email'],
    });

    const { tried, answer } = await guessingTurn(deferredTool);

    expect(tried).toEqual(['email']);
    expect(answer).toBe(
      'The Email connector is set up but turned off for this chat. The person can turn it on in Add-ons, Connectors. Do not try other names; tell the person this.',
    );
  });

  it('reads a mail-like guess as the Email connector', async () => {
    const deferredTool = new DeferredTool(chatServers(), {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      setUpConnectorNames: ['github', 'parallel-web', 'Email'],
    });

    const said = ErrorSchema.parse(JSON.parse(await listToolsText(deferredTool, 'gmail')));

    expect(said.error).toContain('The Email connector is set up but turned off for this chat.');
  });

  it('says the Email connector is set up but not answering yet when it does not list its tools', async () => {
    const email = {
      ...makeMockIMCPServer({ name: 'Email', preload: false }),
      listTools: jest.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    };
    const deferredTool = new DeferredTool([...chatServers(), email], {
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      setUpConnectorNames: ['github', 'parallel-web', 'Email'],
    });

    // The chat lists Email, so the model asks for it by its real name first.
    const { tried, answer } = await guessingTurn(deferredTool, ['Email', ...GUESSES]);

    expect(tried).toEqual(['Email']);
    expect(answer).toBe(
      'The Email connector is set up but is not answering yet. Try again in a minute. Do not try other names; tell the person this if it keeps failing.',
    );
  });
});
