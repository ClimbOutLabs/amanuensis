import { z } from 'zod';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { toolOutputScreen } from '../../src/core/capabilities/builtins/ToolOutputScreen';
import { EventType } from '../../src/core/events/schema';
import type { LLMCreateParamsStreaming } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { finalAnswerStream, makeMockIMCPServer, OBJECT_INPUT_SCHEMA, unknownToolStream } from '../core/harnessMocks';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const CONNECTOR = 'demo-data';
const READ_TOOL = 'read_records';
const PRESENT = 'present_exact_values';
const WRONG_GUESS = 'The flight is AZ 0402 and the total is 100.19 USD.';
const FAILED_NOTE = 'I couldn’t verify those values. Ask me to look them up again.';

const mixedResult = {
  flights: [
    { flight_number: 'AZ 0042', from: 'SFO', to: 'JFK', departs: '2026-11-17T09:05:00-08:00' },
    { flight_number: 'AZ 0024', from: 'LAX', to: 'JFK', departs: '2026-11-17T08:55:00-08:00' },
  ],
  stats: [
    {
      period: '2026 Q3',
      count: 0,
      rate: '0.00470',
      unit: 'percent',
      dataset_id: '00018446744073709551617',
      rounded_before_admission: 0.0007,
    },
  ],
  balances: [
    { account: 'Checking', amount: '100.10', currency: 'USD' },
    { account: 'Savings', amount: '-0.010', currency: 'USD' },
    { account: 'Foreign', amount: '20.50', currency: 'EUR' },
  ],
};

const RowSchema = z.object({ ref: z.string(), path: z.string(), fields: z.array(z.string()) });
const RowsSchema = z.array(RowSchema);
type SourceRow = z.infer<typeof RowSchema>;

function sourceRows(request: LLMCreateParamsStreaming): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const message of request.messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const match = message.content.match(/"exact_source_rows":(.*?),"exact_source_instructions"/s);
    if (match?.[1] !== undefined) rows.push(...RowsSchema.parse(JSON.parse(match[1])));
  }
  return rows;
}

function selectedRow(rows: SourceRow[], path: string) {
  const row = rows.find(candidate => candidate.path === path);
  if (row === undefined) throw new Error(`Missing source row ${path}`);
  return row;
}

// Put the wrong prose in its own chunk before the presentation call arrives.
async function* presentation(args: object): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage> {
  yield {
    id: 'wrong-prose',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { role: 'assistant', content: WRONG_GUESS }, finish_reason: null }],
  };
  const call = {
    id: 'present',
    type: 'function',
    function: { name: PRESENT, arguments: JSON.stringify(args) },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  yield {
    id: 'present-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: WRONG_GUESS, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function fixture() {
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store });
  const session = await sessions.create({
    tenant_id: 'tenant-test',
    session_id: 'exact-values-chat',
    created_by_subject: { subject_id: 'user-test', subject_type: 'user', subject_display_name: 'Test' },
    external_id: null,
    agent: { type: 'inline', spec: makeAgentSpec() },
  });

  async function send(input: {
    onRequest: (request: LLMCreateParamsStreaming, index: number) => ReturnType<typeof presentation>;
    withheld: boolean;
    previousTurnId: string;
  }) {
    const connector = makeMockIMCPServer({
      name: CONNECTOR,
      preload: true,
      tools: [{ name: READ_TOOL, description: 'Read source records', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(connector.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: CONNECTOR,
      mcp_server_name: CONNECTOR,
      original_tool_name: READ_TOOL,
      is_approval_required: false,
      open_world_hint: true,
      read_only_hint: true,
    });
    jest.mocked(connector.callTool).mockResolvedValue({
      result: { content: [], structuredContent: mixedResult },
      wasInitialized: undefined,
      verificationReceiptCandidate: undefined,
    });
    const classify = jest.fn().mockResolvedValue({ ok: true, flagged: input.withheld, score: 0.99, reasonCode: null });
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return input.onRequest(request, requests.length - 1);
    });
    function resolver() {
      const configured = makeTestResolver({
        modelClient: makeMockILLM({ create }),
        extraCapabilities: [toolOutputScreen({ classifier: { classify }, timeoutMs: 250 })],
      });
      const resolve = configured.resolveAgentDefinition.bind(configured);
      configured.resolveAgentDefinition = async options => {
        const resolved = await resolve(options);
        return { ...resolved, definition: { ...resolved.definition, toolSets: [connector] } };
      };
      return configured;
    }
    const first = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Show the exact values from the source.' }],
      previous_turn_id: input.previousTurnId,
      signal: new AbortController().signal,
      resolver: resolver(),
    });
    const waiting = await Array.fromAsync(first.stream());
    const approval = waiting.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED);
    const callId = approval?.tool_calls[0]?.id;
    if (callId === undefined) throw new Error('Expected an approval for the connector read');
    expect(connector.callTool).not.toHaveBeenCalled();
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: callId,
          approval: { status: 'allow' },
        },
      ],
      previous_turn_id: first.id,
      signal: new AbortController().signal,
      resolver: resolver(),
    });
    const events = await Array.fromAsync(turn.stream());
    const reloaded = await new Sessions({ sessionStore: store }).get({
      tenant_id: 'tenant-test',
      session_id: session.session_id,
    });
    if (reloaded === undefined) throw new Error('Could not reload the session');
    const { data: history } = await reloaded.listEvents({ limit: 50 });
    const reloadedTurn = await reloaded.getTurn(turn.id);
    return { create, events, history, classify, connector, turn, reloadedTurn };
  }

  return { send };
}

function read() {
  return unknownToolStream({ toolName: READ_TOOL, callId: 'read-source' });
}

function liveText(events: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['send']>>['events']): string {
  return events
    .flatMap(event => {
      if (event.type !== EventType.MODEL_MESSAGE && event.type !== EventType.MODEL_MESSAGE_DELTA) return [];
      return typeof event.content === 'string' ? [event.content] : [];
    })
    .join('');
}

describe('exact source values through the live and saved chat', () => {
  it('shows connector identifiers, statistics, and exact arithmetic in the final answer without model re-copying', async () => {
    const harness = await fixture();
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        const offered = request.tools?.some(tool => tool.type === 'function' && tool.function.name === PRESENT);
        if (index === 0) {
          expect(offered).toBe(false);
          return read();
        }
        if (index > 1) return finalAnswerStream(WRONG_GUESS);
        expect(offered).toBe(true);
        const rows = sourceRows(request);
        const flight = selectedRow(rows, '/flights/0');
        const stat = selectedRow(rows, '/stats/0');
        const checking = selectedRow(rows, '/balances/0');
        const savings = selectedRow(rows, '/balances/1');
        expect(stat.fields).not.toContain('/rounded_before_admission');
        const moneyFields = ['/account', '/amount', '/currency'];
        return presentation({
          rows: [
            { ref: flight.ref, fields: ['/flight_number', '/from', '/to', '/departs'] },
            { ref: stat.ref, fields: ['/period', '/count', '/rate', '/unit', '/dataset_id'] },
            { ref: checking.ref, fields: moneyFields },
            { ref: savings.ref, fields: moneyFields },
          ],
          sum: { refs: [checking.ref, savings.ref], value_field: '/amount', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(2);
    expect(result.connector.callTool).toHaveBeenCalledTimes(1);
    expect(result.classify).toHaveBeenCalledTimes(1);
    const visible = liveText(result.events);
    expect(visible).toContain('`AZ 0042`');
    expect(visible).toContain('`SFO`');
    expect(visible).not.toContain('AZ 0024');
    expect(visible).not.toContain('`LAX`');
    expect(visible).toContain('`2026-11-17T09:05:00-08:00`');
    expect(visible).toContain('`2026 Q3`');
    expect(visible).toContain('`count` — `0`');
    expect(visible).toContain('`0.00470`');
    expect(visible).toContain('`00018446744073709551617`');
    expect(visible).toContain('`percent`');
    expect(visible).toContain('`100.10`');
    expect(visible).toContain('`-0.010`');
    expect(visible).toContain('**Total** — `100.090` `USD`');
    expect(visible).not.toContain(WRONG_GUESS);
    expect(visible).not.toContain('100.19');
    expect(result.turn.state).toMatchObject({ status: 'done', output: { content: visible } });
    expect(result.reloadedTurn?.state).toMatchObject({ status: 'done', output: { content: visible } });
    const saved = result.history.flatMap(row =>
      row.event.type === EventType.MODEL_MESSAGE ? [row.event.content] : [],
    );
    expect(saved.filter(content => typeof content === 'string' && content !== '')).toEqual([visible]);
  });

  it('gives screened-off values no references or permit to re-emit them', async () => {
    const harness = await fixture();
    const result = await harness.send({
      withheld: true,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        expect(request.tools?.some(tool => tool.type === 'function' && tool.function.name === PRESENT)).toBe(false);
        expect(sourceRows(request)).toEqual([]);
        expect(JSON.stringify(request.messages)).not.toContain('AZ 0042');
        return finalAnswerStream('The connector data was withheld.');
      },
    });
    expect(result.classify).toHaveBeenCalledTimes(1);
    expect(liveText(result.events)).toBe('The connector data was withheld.');
  });

  it.each(['another turn', 'mixed currencies', 'unrepresentable amount', 'missing field'])(
    'refuses to present values using %s',
    async reason => {
      const harness = await fixture();
      let oldRef: string | undefined;
      let previousTurnId = 'none';
      if (reason === 'another turn') {
        const prior = await harness.send({
          withheld: false,
          previousTurnId,
          onRequest: (request, index) => {
            if (index === 0) return read();
            oldRef = selectedRow(sourceRows(request), '/flights/0').ref;
            return finalAnswerStream('Source read.');
          },
        });
        previousTurnId = prior.turn.id;
      }
      const result = await harness.send({
        withheld: false,
        previousTurnId,
        onRequest: (request, index) => {
          if (index === 0) return read();
          if (index > 1) return finalAnswerStream(WRONG_GUESS);
          const rows = sourceRows(request);
          const stat = selectedRow(rows, '/stats/0');
          const first = selectedRow(rows, '/balances/0');
          const foreign = selectedRow(rows, '/balances/2');
          const moneyFields = ['/amount', '/currency'];
          if (reason === 'mixed currencies') {
            return presentation({
              rows: [
                { ref: first.ref, fields: moneyFields },
                { ref: foreign.ref, fields: moneyFields },
              ],
              sum: { refs: [first.ref, foreign.ref], value_field: '/amount', unit_field: '/currency' },
            });
          }
          return presentation({
            rows: [
              {
                ref: oldRef ?? stat.ref,
                fields: reason === 'unrepresentable amount' ? ['/rounded_before_admission'] : ['/flight_number'],
              },
            ],
          });
        },
      });
      expect(result.create).toHaveBeenCalledTimes(3);
      expect(liveText(result.events)).toBe(FAILED_NOTE);
      expect(result.reloadedTurn?.state).toMatchObject({ status: 'done', output: { content: FAILED_NOTE } });
    },
  );
});
