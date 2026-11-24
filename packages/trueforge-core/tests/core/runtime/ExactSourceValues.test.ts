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

  it('never renders the rounded float after a pause, and does not silently drop the section', () => {
    const { result, ref } = prepared();
    const second = new ExactSourceValues(NOOP_AGENT_TRACING);
    second.adoptContextResults([persistedResult(result)]);
    expect(second.hasRows).toBe(true);

    // The fractional amount survives the pause exactly.
    const money = second.composedAnswer([presentation(ref, ['/amount', '/currency'])]);
    expect(money).toContain('Amount: 10.5');
    expect(money).toContain('Currency: USD');
    expect(money).not.toContain('9007199254740992');

    // The beyond-safe-range integer cannot be rebuilt from the plain parse, so its field
    // is not adopted. A section that named it can no longer be rendered exactly, and the
    // composed answer falls back to the could-not-verify note instead of showing the
    // rounded value or quietly losing the section.
    const withId = second.composedAnswer([presentation(ref, ['/name', '/record_id'])]);
    expect(withId).toBeUndefined();
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
