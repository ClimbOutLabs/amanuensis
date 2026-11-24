import type { ToolCallResult } from '../../../src/core/mcp/executeToolCalls';
import { ExactSourceValues, type ExactContextResult } from '../../../src/core/runtime/ExactSourceValues';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

const CONNECTOR = 'demo-data';
const TOOL = 'read_records';
// The exact instructions text prepare() writes into a replaced result. Pinning it here
// pins the envelope shape adoption accepts: a stored result only counts as replaced when
// it carries this text, and the control test below fails if the two drift apart.
const INSTRUCTIONS =
  'For a reply reporting exact values from these rows, call present_exact_values by itself. Select row references and field paths. Call it again by itself to show more values. Finish with an empty message when every value is shown; the host writes the reply from the values shown.';

function makeResult(rawContent: string): ToolCallResult {
  return {
    message: { role: 'tool', tool_call_id: 'call-1', content: rawContent },
    rawContent,
    images: [],
    toolCallInfo: {
      type: 'mcp',
      mcp_server_id: CONNECTOR,
      mcp_server_name: CONNECTOR,
      original_tool_name: TOOL,
    },
    screen: undefined,
    failure: false,
    isStructuredContent: true,
    completedAt: new Date().toISOString(),
    memoized: false,
    repeatCount: 0,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'executed_ok',
    remediation: undefined,
    admissionProvenance: { source: 'automatic' },
  };
}

/** The persisted form of a prepared result: the replaced content prepare() wrote, wrapped as a tool response. */
function persistedResult(result: ToolCallResult): ExactContextResult {
  return {
    call_id: 'call-1',
    connector: CONNECTOR,
    tool: TOOL,
    content: JSON.stringify({ result: JSON.parse(result.message.content) }),
  };
}

function forgedResult(envelope: unknown): ExactContextResult {
  return { call_id: 'call-9', connector: CONNECTOR, tool: TOOL, content: JSON.stringify({ result: envelope }) };
}

function onlyRef(rows: readonly { ref: string }[]): string {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected one prepared row');
  return row.ref;
}

function refAt(rows: readonly { ref: string }[], index: number): string {
  const row = rows[index];
  if (row === undefined) throw new Error(`Expected a prepared row at index ${String(index)}`);
  return row.ref;
}

/**
 * The text a Markdown reader sees: a backslash before a punctuation character renders as
 * that character itself, so resolving those escapes recovers the visible text.
 */
function visibleText(markdown: string): string {
  return markdown.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function presentation(ref: string, fields: string[]): { arguments: string; succeeded: boolean } {
  return { arguments: JSON.stringify({ rows: [{ ref, fields }] }), succeeded: true };
}

describe('ExactSourceValues adoption after an approval pause', () => {
  const raw = '{"records":[{"name":"Ledger A","record_id":9007199254740993,"amount":10.5,"currency":"USD"}]}';

  function prepared() {
    const first = new ExactSourceValues(NOOP_AGENT_TRACING);
    const result = makeResult(raw);
    const rows = first.prepare(result, 0);
    first.commit(rows);
    return { first, result, ref: onlyRef(rows) };
  }

  it('renders an integer beyond the safe range digit for digit in the first instance', () => {
    const { first, ref } = prepared();
    const answer = first.composedAnswer([presentation(ref, ['/record_id'])]);
    expect(answer).toContain('Record id: 9007199254740993');
  });

  it('renders the beyond-safe-range integer digit for digit after a pause', () => {
    const { result, ref } = prepared();
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([persistedResult(result)]);
    expect(second.hasRows).toBe(true);

    // The fractional amount survives the pause exactly.
    const money = second.composedAnswer([presentation(ref, ['/amount', '/currency'])]);
    expect(money).toContain('Amount: 10.5');
    expect(money).toContain('Currency: USD');

    // The persisted exact parse carries the integer's source digits, so the pause does
    // not round it to the nearest float either.
    const withId = second.composedAnswer([presentation(ref, ['/name', '/record_id'])]);
    expect(withId).toContain('Record id: 9007199254740993');
    expect(withId).not.toContain('9007199254740992');
  });

  it('does not adopt an envelope-shaped result that prepare() would have declined for size', () => {
    const envelope = {
      connector_result: { records: [{ note: 'x'.repeat(33_000), amount: 10.5, currency: 'USD' }] },
      exact_source_rows: [{ ref: 'row_AAAAAAAAAAAA', path: '/records/0', fields: ['/amount', '/currency'] }],
      exact_source_instructions: INSTRUCTIONS,
    };
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([forgedResult(envelope)]);
    expect(second.hasRows).toBe(false);
    expect(second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/amount'])])).toBeUndefined();
  });

  it('does not adopt an envelope missing the instructions prepare() always writes', () => {
    const envelope = {
      connector_result: { records: [{ amount: 10.5, currency: 'USD' }] },
      exact_source_rows: [{ ref: 'row_AAAAAAAAAAAA', path: '/records/0', fields: ['/amount', '/currency'] }],
    };
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([forgedResult(envelope)]);
    expect(second.hasRows).toBe(false);
    expect(second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/amount'])])).toBeUndefined();
  });

  it('adopts a complete envelope within the gates, keeping only the fields the result carries', () => {
    const envelope = {
      connector_result: { records: [{ amount: 10.5, currency: 'USD' }] },
      exact_source_result: { records: [{ amount: '10.5', currency: 'USD' }] },
      exact_source_rows: [{ ref: 'row_AAAAAAAAAAAA', path: '/records/0', fields: ['/amount', '/currency', '/secret'] }],
      exact_source_instructions: INSTRUCTIONS,
    };
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([forgedResult(envelope)]);
    expect(second.hasRows).toBe(true);
    const answer = second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/amount', '/currency'])]);
    expect(answer).toContain('Amount: 10.5');
    // The advertised field the stored result does not carry is not adopted, so a section
    // naming it can no longer be rendered exactly.
    expect(second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/secret'])])).toBeUndefined();
  });
});

describe('ExactSourceValues approval pause keeps the source digits', () => {
  function paused(rawContent: string) {
    const first = new ExactSourceValues(NOOP_AGENT_TRACING);
    const result = makeResult(rawContent);
    const rows = first.prepare(result, 0);
    first.commit(rows);
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([persistedResult(result)]);
    return { rows, second };
  }

  it('presents and sums a fraction the plain parse rounds, digit for digit after a pause', () => {
    // The plain parse of this literal is 100000000000000.02. The source wrote .01.
    const rawContent =
      '{"records":[{"name":"Ledger A","amount":100000000000000.01,"currency":"USD"},' +
      '{"name":"Ledger B","amount":100000000000000.01,"currency":"USD"}]}';
    const { rows, second } = paused(rawContent);
    const first = refAt(rows, 0);
    const other = refAt(rows, 1);
    const fields = ['/amount', '/currency'];
    const answer = second.composedAnswer([
      {
        arguments: JSON.stringify({
          rows: [
            { ref: first, fields },
            { ref: other, fields },
          ],
          sum: { refs: [first, other], value_field: '/amount', unit_field: '/currency' },
        }),
        succeeded: true,
      },
    ]);
    expect(answer).toContain('Amount: 100000000000000.01');
    expect(answer).toContain('Total: 200000000000000.02 USD');
    expect(answer).not.toContain('Amount: 100000000000000.02');
  });

  it('presents a fraction the plain parse collapses to a whole number, digit for digit after a pause', () => {
    // The plain parse of this literal is the whole number 1. The source wrote a fraction.
    const rawContent = '{"records":[{"name":"Sample 1","ratio":1.0000000000000001,"unit":"index"}]}';
    const { rows, second } = paused(rawContent);
    const answer = second.composedAnswer([presentation(onlyRef(rows), ['/ratio'])]);
    const line = answer?.split('\n').find(candidate => candidate.startsWith('Ratio:'));
    expect(line).toBe('Ratio: 1.0000000000000001');
  });

  it('fails verification for numbers in a result persisted without its exact parse', () => {
    // An envelope in the older shape: only the plain parse was stored, so every number
    // in it may already be rounded. Strings survive a plain parse exactly and still
    // adopt. Numbers do not, not even a whole number in the safe range, because the
    // source may have written it with a fraction the parse collapsed away.
    const envelope = {
      connector_result: { records: [{ name: 'Ledger 7', amount: 10.5, ratio: 1 }] },
      exact_source_rows: [{ ref: 'row_AAAAAAAAAAAA', path: '/records/0', fields: ['/name', '/amount', '/ratio'] }],
      exact_source_instructions: INSTRUCTIONS,
    };
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([forgedResult(envelope)]);
    expect(second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/name'])])).toContain('Name: Ledger 7');
    expect(second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/amount'])])).toBeUndefined();
    expect(second.composedAnswer([presentation('row_AAAAAAAAAAAA', ['/ratio'])])).toBeUndefined();
  });
});

describe('ExactSourceValues Markdown rendering', () => {
  it('shows delimiter-bearing identifiers exactly as the source wrote them', () => {
    const rawContent =
      '{"records":[{"lot_id":"LOT*12*A","batch_code":"BATCH_0042","tag":"ID`42`",' +
      '"note":"a [draft] copy","amount":10.5,"currency":"USD"}]}';
    const first = new ExactSourceValues(NOOP_AGENT_TRACING);
    const result = makeResult(rawContent);
    const rows = first.prepare(result, 0);
    first.commit(rows);
    const answer = first.composedAnswer([
      presentation(onlyRef(rows), ['/lot_id', '/batch_code', '/tag', '/note', '/amount', '/currency']),
    ]);
    if (answer === undefined) throw new Error('Expected a composed answer');

    // The Markdown source escapes each delimiter, so the rendered text is the source text.
    expect(answer).toContain('Lot id: LOT\\*12\\*A');
    expect(answer).toContain('Batch code: BATCH\\_0042');
    expect(answer).toContain('Tag: ID\\`42\\`');
    expect(answer).toContain('Note: a \\[draft\\] copy');
    const visible = visibleText(answer);
    expect(visible).toContain('Lot id: LOT*12*A');
    expect(visible).toContain('Batch code: BATCH_0042');
    expect(visible).toContain('Tag: ID`42`');
    expect(visible).toContain('Note: a [draft] copy');

    // Ordinary values render exactly as before, with nothing escaped.
    expect(answer).toContain('Amount: 10.5');
    expect(answer).toContain('Currency: USD');
  });
});
