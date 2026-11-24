import { z } from 'zod';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { toolOutputScreen } from '../../src/core/capabilities/builtins/ToolOutputScreen';
import { EventType } from '../../src/core/events/schema';
import type { LLMCreateParamsStreaming } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { isRecord } from '../../src/core/util/records';
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
      p_value: 7e-8,
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

async function fixture(results: unknown[] = [mixedResult], iterationLimit?: number, openWorldHint = true) {
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store });
  const session = await sessions.create({
    tenant_id: 'tenant-test',
    session_id: 'exact-values-chat',
    created_by_subject: { subject_id: 'user-test', subject_type: 'user', subject_display_name: 'Test' },
    external_id: null,
    agent: {
      type: 'inline',
      spec: makeAgentSpec(iterationLimit === undefined ? {} : { config: { iteration_limit: iterationLimit } }),
    },
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
      open_world_hint: openWorldHint,
      read_only_hint: true,
    });
    const queue = [...results];
    jest.mocked(connector.callTool).mockImplementation(() => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve({
        result: { content: [], structuredContent: isRecord(next) ? next : undefined },
        wasInitialized: undefined,
        verificationReceiptCandidate: undefined,
      });
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
    let turn = first;
    let events = await Array.fromAsync(first.stream());
    // A turn can pause for more than one approval in a row (one per connector call the model
    // makes). Approve each in turn until the chat runs to completion.
    for (let round = 0; round < 4; round++) {
      const approval = events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED);
      const callId = approval?.tool_calls[0]?.id;
      if (callId === undefined) break;
      if (round === 0) {
        expect(connector.callTool).not.toHaveBeenCalled();
      }
      turn = await session.createTurn({
        turn_id: mintTestTurnId(),
        input: [
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: 'main',
            tool_call_id: callId,
            approval: { status: 'allow' },
          },
        ],
        previous_turn_id: turn.id,
        signal: new AbortController().signal,
        resolver: resolver(),
      });
      events = await Array.fromAsync(turn.stream());
    }
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

function ledgerAmount(index: number): number | string {
  if (index === 0) return 350;
  if (index === 1) return 5.5;
  if (index === 2) return -63.62;
  return `${String(index * 7 + 13)}.42`;
}

const ledgerResult = {
  transactions: Array.from({ length: 30 }, (_, index) => ({
    id: `txn-${String(index + 1).padStart(3, '0')}`,
    date: `2026-11-${String((index % 28) + 1).padStart(2, '0')}`,
    merchant: `Merchant ${String(index + 1)}`,
    amount: ledgerAmount(index),
    currency: 'USD',
    status: index % 2 === 0 ? 'posted' : 'pending',
    category: { primary: 'Retail', detailed: 'General' },
  })),
  warnings: [],
};

function ledgerRows(request: LLMCreateParamsStreaming): SourceRow[] {
  return sourceRows(request)
    .filter(row => row.path.startsWith('/transactions/'))
    .sort(
      (a, b) => Number(a.path.slice(a.path.lastIndexOf('/') + 1)) - Number(b.path.slice(b.path.lastIndexOf('/') + 1)),
    );
}

async function* pairedPresentation(
  args: object,
  otherArgs: object,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage> {
  const presentCall = {
    id: 'present',
    type: 'function',
    function: { name: PRESENT, arguments: JSON.stringify(args) },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  const otherCall = {
    id: 'present-again',
    type: 'function',
    function: { name: PRESENT, arguments: JSON.stringify(otherArgs) },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  yield {
    id: 'paired-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, ...presentCall },
            { index: 1, ...otherCall },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [presentCall, otherCall] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
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
        expect(stat.fields).toContain('/rounded_before_admission');
        expect(stat.fields).not.toContain('/p_value');
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

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(result.connector.callTool).toHaveBeenCalledTimes(1);
    expect(result.classify).toHaveBeenCalledTimes(1);
    const visible = liveText(result.events);
    expect(visible).toContain('Flight number: AZ 0042');
    expect(visible).toContain('SFO');
    expect(visible).not.toContain('AZ 0024');
    expect(visible).not.toContain('LAX');
    expect(visible).toContain('2026-11-17T09:05:00-08:00');
    expect(visible).toContain('2026 Q3');
    expect(visible).toContain('Count: 0');
    expect(visible).toContain('0.00470');
    expect(visible).toContain('00018446744073709551617');
    expect(visible).toContain('percent');
    expect(visible).toContain('100.10');
    expect(visible).toContain('-0.010');
    expect(visible).toContain('Total: 100.090 USD');
    expect(visible).toContain('Source: demo-data');
    expect(visible).not.toContain(READ_TOOL);
    expect(visible).not.toContain('/flight_number');
    expect(visible).not.toContain('/balances/0');
    expect(visible).not.toContain('`');
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

  it.each([
    {
      reason: 'another turn',
      refusal: 'is not from this request. Use only the row references listed with this turn',
    },
    {
      reason: 'mixed currencies',
      refusal: 'The summed rows do not share one unit. Sum rows with the same unit together.',
    },
    {
      reason: 'exponent amount',
      refusal: 'The row at /stats/0 does not carry the field /p_value. Use only the fields listed for that row.',
    },
    {
      reason: 'missing field',
      refusal: 'The row at /stats/0 does not carry the field /flight_number. Use only the fields listed for that row.',
    },
  ])('refuses to present values using $reason', async ({ reason, refusal }) => {
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
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId,
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
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
              fields: reason === 'exponent amount' ? ['/p_value'] : ['/flight_number'],
            },
          ],
        });
      },
    });
    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain(refusal);
    expect(liveText(result.events)).toBe(FAILED_NOTE);
    expect(result.reloadedTurn?.state).toMatchObject({ status: 'done', output: { content: FAILED_NOTE } });
  });
  it('shows a thirty-row result in full across successive presentation calls', async () => {
    const harness = await fixture([ledgerResult], 12);
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 6) return finalAnswerStream(WRONG_GUESS);
        const rows = ledgerRows(request);
        expect(rows).toHaveLength(30);
        expect(rows[0]?.fields).toHaveLength(8);
        const group = rows.slice((index - 1) * 5, index * 5);
        return presentation({ rows: group.map(row => ({ ref: row.ref, fields: row.fields })) });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(8);
    const visible = liveText(result.events);
    for (let index = 0; index < 30; index++) {
      expect(visible).toContain(`Merchant ${String(index + 1)}`);
      expect(visible).toContain(`Amount: ${String(ledgerAmount(index))}`);
    }
    expect(visible).toContain('Amount: 350');
    expect(visible).toContain('Amount: 5.5');
    expect(visible).toContain('Amount: -63.62');
    expect(visible).toContain('Category primary: Retail');
    expect(visible.indexOf('Merchant 1')).toBeLessThan(visible.indexOf('Merchant 16'));
    expect(visible.indexOf('Merchant 16')).toBeLessThan(visible.indexOf('Merchant 30'));
    expect(visible).not.toContain(WRONG_GUESS);
    expect(visible).not.toContain('`');
    expect(result.turn.state).toMatchObject({ status: 'done', output: { content: visible } });
  });

  it('shows a three-row result with a nested object field in one answer', async () => {
    const nestedResult = {
      transactions: [0, 1, 2].map(index => ({
        id: `item-${String(index + 1)}`,
        date: '2026-11-20',
        merchant: `Shop ${String(index + 1)}`,
        amount: index === 0 ? 350 : index === 1 ? 5.5 : -63.62,
        currency: 'USD',
        status: 'posted',
        note: `Note ${String(index + 1)}`,
        channel: 'card',
        category: { primary: 'Retail', detailed: 'General' },
      })),
      warnings: [],
    };
    const harness = await fixture([nestedResult]);
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) return finalAnswerStream(WRONG_GUESS);
        const rows = ledgerRows(request);
        expect(rows).toHaveLength(3);
        expect(rows[0]?.fields).toHaveLength(10);
        return presentation({ rows: rows.map(row => ({ ref: row.ref, fields: row.fields })) });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    const visible = liveText(result.events);
    expect(visible).toContain('Shop 1');
    expect(visible).toContain('Shop 2');
    expect(visible).toContain('Shop 3');
    expect(visible).toContain('Amount: 350');
    expect(visible).toContain('Amount: 5.5');
    expect(visible).toContain('Amount: -63.62');
    expect(visible).toContain('Category detailed: General');
    expect(visible).not.toContain(WRONG_GUESS);
  });

  it('shows fractional amounts and a fractional balance exactly, with a sum across the fractions', async () => {
    const bankResult = {
      accounts: [{ name: 'Everyday Checking', balance: { current: 1234.56, available: 1200.5 }, currency: 'USD' }],
      transactions: [
        { merchant: 'Payroll Deposit', amount: 350, currency: 'USD' },
        { merchant: 'Coffee Cart', amount: 5.5, currency: 'USD' },
        { merchant: 'Grocery Store', amount: -63.62, currency: 'USD' },
      ],
    };
    const harness = await fixture([bankResult]);
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) return finalAnswerStream(WRONG_GUESS);
        const rows = sourceRows(request);
        const account = selectedRow(rows, '/accounts/0');
        const deposits = [0, 1, 2].map(i => selectedRow(rows, `/transactions/${String(i)}`));
        return presentation({
          rows: [
            { ref: account.ref, fields: account.fields },
            ...deposits.map(row => ({ ref: row.ref, fields: row.fields })),
          ],
          sum: { refs: deposits.map(row => row.ref), value_field: '/amount', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    const visible = liveText(result.events);
    expect(visible).toContain('Balance current: 1234.56');
    expect(visible).toContain('Balance available: 1200.5');
    expect(visible).toContain('Payroll Deposit');
    expect(visible).toContain('Coffee Cart');
    expect(visible).toContain('Grocery Store');
    expect(visible).toContain('Amount: 350');
    expect(visible).toContain('Amount: 5.5');
    expect(visible).toContain('Amount: -63.62');
    expect(visible).toContain('Total: 291.88 USD');
    expect(visible).not.toContain('/balance/current');
    expect(visible).not.toContain(READ_TOOL);
    expect(visible).not.toContain('`');
    expect(visible).not.toContain(WRONG_GUESS);
  });

  it('shows values from two results in one turn in the same reply', async () => {
    const recentResult = { transactions: [{ merchant: 'Bakery', amount: 12.5, currency: 'USD' }] };
    const olderResult = { transactions: [{ merchant: 'Bookshop', amount: 30, currency: 'USD' }] };
    const harness = await fixture([recentResult, olderResult], undefined, false);
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) {
          return unknownToolStream({ toolName: READ_TOOL, callId: 'read-recent', args: '{"window":"recent"}' });
        }
        if (index === 1) {
          return unknownToolStream({ toolName: READ_TOOL, callId: 'read-older', args: '{"window":"older"}' });
        }
        if (index > 2) return finalAnswerStream(WRONG_GUESS);
        const rows = ledgerRows(request);
        expect(rows).toHaveLength(2);
        return presentation({
          rows: rows.map(row => ({ ref: row.ref, fields: ['/merchant', '/amount', '/currency'] })),
        });
      },
    });

    expect(result.connector.callTool).toHaveBeenCalledTimes(2);
    expect(result.create).toHaveBeenCalledTimes(4);
    const visible = liveText(result.events);
    expect(visible).toContain('Bakery');
    expect(visible).toContain('Amount: 12.5');
    expect(visible).toContain('Bookshop');
    expect(visible).toContain('Amount: 30');
    expect(visible).not.toContain(WRONG_GUESS);
  });

  it('keeps a presented section when the request pauses for another approval before finishing', async () => {
    const firstResult = { transactions: [{ merchant: 'Bakery', amount: 12.5, currency: 'USD' }] };
    const secondResult = { transactions: [{ merchant: 'Bookshop', amount: 30, currency: 'USD' }] };
    const harness = await fixture([firstResult, secondResult]);
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) {
          return unknownToolStream({ toolName: READ_TOOL, callId: 'read-recent', args: '{"window":"recent"}' });
        }
        if (index === 1) {
          const row = selectedRow(sourceRows(request), '/transactions/0');
          return presentation({ rows: [{ ref: row.ref, fields: ['/merchant', '/amount', '/currency'] }] });
        }
        if (index === 2) {
          return unknownToolStream({ toolName: READ_TOOL, callId: 'read-older', args: '{"window":"older"}' });
        }
        return finalAnswerStream(WRONG_GUESS);
      },
    });

    expect(result.connector.callTool).toHaveBeenCalledTimes(2);
    expect(result.create).toHaveBeenCalledTimes(4);
    const visible = liveText(result.events);
    expect(visible).toContain('Bakery');
    expect(visible).toContain('Amount: 12.5');
    expect(visible).not.toContain('Bookshop');
    expect(visible).not.toContain(WRONG_GUESS);
    expect(result.turn.state).toMatchObject({ status: 'done', output: { content: visible } });
  });

  it('names the field limit on an over-full call and accepts a corrected retry', async () => {
    const harness = await fixture([ledgerResult]);
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 2) return finalAnswerStream(WRONG_GUESS);
        const rows = ledgerRows(request);
        if (index === 2) {
          seenByModel.push(JSON.stringify(request.messages));
          const group = rows.slice(0, 5);
          return presentation({ rows: group.map(row => ({ ref: row.ref, fields: row.fields })) });
        }
        const group = rows.slice(0, 6);
        return presentation({ rows: group.map(row => ({ ref: row.ref, fields: row.fields })) });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(4);
    expect(seenByModel.join('')).toContain(
      'That call named 48 fields. One call can show at most 40 fields. Split the rows across more calls, each one within the limit.',
    );
    const visible = liveText(result.events);
    expect(visible).toContain('Merchant 1');
    expect(visible).toContain('Merchant 5');
    expect(visible).not.toContain('Merchant 6');
    expect(visible).not.toContain(WRONG_GUESS);
  });

  it('names a field that was named twice for one row', async () => {
    const harness = await fixture();
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const checking = selectedRow(sourceRows(request), '/balances/0');
        return presentation({ rows: [{ ref: checking.ref, fields: ['/amount', '/amount'] }] });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain('The field /amount was named twice for one row. Name each field once.');
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('refuses a presentation call that shares its step with another call', async () => {
    const harness = await fixture();
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const rows = sourceRows(request);
        const flight = selectedRow(rows, '/flights/0');
        const stat = selectedRow(rows, '/stats/0');
        return pairedPresentation(
          { rows: [{ ref: flight.ref, fields: ['/flight_number'] }] },
          { rows: [{ ref: stat.ref, fields: ['/period'] }] },
        );
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain(
      'This tool must be the only tool call in its step. Call it again by itself.',
    );
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('shows a repeated presentation once and tells the model it is already shown', async () => {
    const harness = await fixture();
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 2) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const checking = selectedRow(sourceRows(request), '/balances/0');
        const savings = selectedRow(sourceRows(request), '/balances/1');
        const moneyFields = ['/account', '/amount', '/currency'];
        if (index === 2) {
          // The same selection with its rows and fields in another order. A byte-identical
          // repeat never reaches the tool: the thread's own repeat guard stops it first.
          return presentation({
            rows: [
              { ref: savings.ref, fields: [...moneyFields].reverse() },
              { ref: checking.ref, fields: [...moneyFields].reverse() },
            ],
            sum: { refs: [savings.ref, checking.ref], value_field: '/amount', unit_field: '/currency' },
          });
        }
        return presentation({
          rows: [
            { ref: checking.ref, fields: moneyFields },
            { ref: savings.ref, fields: moneyFields },
          ],
          sum: { refs: [checking.ref, savings.ref], value_field: '/amount', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(4);
    expect(seenByModel.join('')).toContain(
      'Those values are already shown in this reply. Show other values, or finish with an empty message.',
    );
    const visible = liveText(result.events);
    expect(visible.split('Amount: 100.10')).toHaveLength(2);
    expect(visible.split('Total: 100.090 USD')).toHaveLength(2);
    expect(visible).not.toContain(WRONG_GUESS);
  });

  it('numbers repeated labels when two fields in one row read the same', async () => {
    const colliding = {
      records: [{ merchant_name: 'Alpha Stores', merchant: { name: 'Beta Shops' }, code: 42 }],
    };
    const harness = await fixture([colliding]);
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) return finalAnswerStream(WRONG_GUESS);
        const row = selectedRow(sourceRows(request), '/records/0');
        return presentation({ rows: [{ ref: row.ref, fields: ['/merchant_name', '/merchant/name'] }] });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    const visible = liveText(result.events);
    expect(visible).toContain('Merchant name (1): Alpha Stores');
    expect(visible).toContain('Merchant name (2): Beta Shops');
    expect(visible).not.toContain(WRONG_GUESS);
  });

  it('names a sum that names the same row more than once', async () => {
    const harness = await fixture();
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const checking = selectedRow(sourceRows(request), '/balances/0');
        return presentation({
          rows: [{ ref: checking.ref, fields: ['/amount', '/currency'] }],
          sum: { refs: [checking.ref, checking.ref], value_field: '/amount', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain('The sum names the same row more than once. Name each summed row once.');
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('names a sum whose amount and unit fields do not sit side by side', async () => {
    const nestedMoney = { accounts: [{ name: 'Everyday', balance: { current: 10.5 }, currency: 'USD' }] };
    const harness = await fixture([nestedMoney]);
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const account = selectedRow(sourceRows(request), '/accounts/0');
        return presentation({
          rows: [{ ref: account.ref, fields: ['/balance/current', '/currency'] }],
          sum: { refs: [account.ref], value_field: '/balance/current', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain(
      'The sum needs an amount field and a unit field that sit side by side on each row. Choose two fields from the same level.',
    );
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('names a summed row that is not shown with both of the summed fields', async () => {
    const harness = await fixture();
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const rows = sourceRows(request);
        const checking = selectedRow(rows, '/balances/0');
        const savings = selectedRow(rows, '/balances/1');
        return presentation({
          rows: [
            { ref: checking.ref, fields: ['/amount', '/currency'] },
            { ref: savings.ref, fields: ['/amount'] },
          ],
          sum: { refs: [checking.ref, savings.ref], value_field: '/amount', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain(
      'Every summed row must also be shown with its /amount and /currency fields. Add the missing fields to the shown rows.',
    );
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('names a sum that mixes rows from more than one result', async () => {
    const recentResult = { transactions: [{ merchant: 'Bakery', amount: 12.5, currency: 'USD' }] };
    const olderResult = { transactions: [{ merchant: 'Bookshop', amount: 30, currency: 'USD' }] };
    const harness = await fixture([recentResult, olderResult], undefined, false);
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) {
          return unknownToolStream({ toolName: READ_TOOL, callId: 'read-recent', args: '{"window":"recent"}' });
        }
        if (index === 1) {
          return unknownToolStream({ toolName: READ_TOOL, callId: 'read-older', args: '{"window":"older"}' });
        }
        if (index > 2) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const rows = ledgerRows(request);
        expect(rows).toHaveLength(2);
        const fields = ['/merchant', '/amount', '/currency'];
        return presentation({
          rows: rows.map(row => ({ ref: row.ref, fields })),
          sum: { refs: rows.map(row => row.ref), value_field: '/amount', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(4);
    expect(seenByModel.join('')).toContain(
      'The sum mixes rows from more than one result. Sum rows from a single result.',
    );
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('names a summed field that is not a plain number', async () => {
    const harness = await fixture();
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const checking = selectedRow(sourceRows(request), '/balances/0');
        return presentation({
          rows: [{ ref: checking.ref, fields: ['/account', '/currency'] }],
          sum: { refs: [checking.ref], value_field: '/account', unit_field: '/currency' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain(
      'The field /account on the row at /balances/0 is not a plain number, so it cannot be summed. Sum a field that holds plain numbers.',
    );
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });

  it('names a summed unit field that does not name a unit', async () => {
    // A plain number literal is carried as its exact text, so it reads as a named unit.
    // A unit field holding a true-or-false value names nothing, and the sum is refused.
    const coded = { records: [{ item: 'Gadget', amount: 10, code: true }] };
    const harness = await fixture([coded]);
    const seenByModel: string[] = [];
    const result = await harness.send({
      withheld: false,
      previousTurnId: 'none',
      onRequest: (request, index) => {
        if (index === 0) return read();
        if (index > 1) {
          seenByModel.push(JSON.stringify(request.messages));
          return finalAnswerStream(WRONG_GUESS);
        }
        const row = selectedRow(sourceRows(request), '/records/0');
        return presentation({
          rows: [{ ref: row.ref, fields: ['/amount', '/code'] }],
          sum: { refs: [row.ref], value_field: '/amount', unit_field: '/code' },
        });
      },
    });

    expect(result.create).toHaveBeenCalledTimes(3);
    expect(seenByModel.join('')).toContain(
      'The field /code on the row at /records/0 does not name a unit, so the sum cannot be checked. Sum rows whose unit field names a unit.',
    );
    expect(liveText(result.events)).toBe(FAILED_NOTE);
  });
});
