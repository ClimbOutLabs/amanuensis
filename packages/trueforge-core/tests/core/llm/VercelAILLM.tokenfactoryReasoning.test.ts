/**
 * Token Factory (Nebius, OpenAI-compatible) serving Nemotron through vLLM. These tests stream
 * scripted chunk sequences through a mocked fetch, so the whole adapter path runs: the think-tag
 * split, the markup guard, and the reply that finally reaches the person.
 *
 * Leaked tool-call markup is held out of the reply, and nothing in it is ever run.
 */
import type { LLMCreateParams } from '../../../src/core/llm/ILLM';
import { VercelAILLM } from '../../../src/core/llm/VercelAILLM';
import { makeSilentLogger } from '../harnessMocks';

const RAW_MARKERS = ['<tool_call', '</tool_call', '<think', '</think', '<tool_calls', '</invoke', '<invoke'];

function sseBodyFor(pieces: string[]): string {
  const frame = (delta: Record<string, unknown>, finishReason: 'stop' | null) =>
    `data: ${JSON.stringify({
      id: 'tf-synthetic',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'nvidia/nemotron-3-super-120b-a12b',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const body = [
    frame({ role: 'assistant' }, null),
    ...pieces.map(piece => frame({ content: piece }, null)),
    frame({}, 'stop'),
  ].join('');
  return `${body}data: [DONE]\n\n`;
}

/** Mocks fetch to stream one answer made of these content pieces, in order. */
function mockContentStream(pieces: string[]): void {
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(
        new Response(sseBodyFor(pieces), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
}

function modelClient(): VercelAILLM {
  return new VercelAILLM({
    logger: makeSilentLogger(),
    providerConfig: {
      provider: { type: 'tokenfactory', name: 'tokenfactory' },
      model: { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'nemotron' },
      name: 'tokenfactory',
      apiKey: 'not-a-real-key',
      headers: {},
    },
  });
}

/** A request, with reasoning asked for or left at the model default. */
function request({ reasoning }: { reasoning: boolean }): LLMCreateParams {
  const body: LLMCreateParams = { messages: [{ role: 'user', content: 'Find my dentist appointment.' }] };
  if (reasoning) {
    Object.assign(body, { reasoning_effort: 'high' });
  }
  return body;
}

describe('Token Factory answer text with think tags', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps reasoning that ends at a bare closing think tag out of the answer', async () => {
    mockContentStream(['Wait, the ID is missing. Let us list spaces again.', '</think>', '\n\nThe space is ready.']);
    const result = await modelClient().createNonStream(request({ reasoning: true }));
    expect(result.output.content).toBe('The space is ready.');
    expect(result.output.content).not.toContain('</think>');
    expect(JSON.stringify(result.output.thinking_blocks)).toContain('Wait, the ID is missing.');
  });

  it.each([true, false])(
    'leaves a normal answer with no think tags unchanged (reasoning requested: %s)',
    async reasoning => {
      mockContentStream(['Your dentist visit is ', 'Monday at 2:30 pm.']);
      const result = await modelClient().createNonStream(request({ reasoning }));
      expect(result.output.content).toBe('Your dentist visit is Monday at 2:30 pm.');
      expect(result.output.thinking_blocks).toBeUndefined();
      expect(result.tool_markup).toBeUndefined();
    },
  );

  it('shows reasoning sent in the reasoning_content field as reasoning, not answer text', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const frames = [
        `data: ${JSON.stringify({ id: 'tf', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Plan the lookup.' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'tf', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { content: 'Found it.' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'tf', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return Promise.resolve(new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });
    const result = await modelClient().createNonStream(request({ reasoning: true }));
    expect(result.output.content).toBe('Found it.');
    expect(JSON.stringify(result.output.thinking_blocks)).toContain('Plan the lookup.');
  });
});

describe('Token Factory stray and leaked tool-call markup', () => {
  afterEach(() => jest.restoreAllMocks());

  it('hides a stray closing tool-call line and keeps the answer around it', async () => {
    mockContentStream(['Checking the calendar.\n', '</tool_call>\n', 'Found it: the dentist visit is Monday.']);
    const result = await modelClient().createNonStream(request({ reasoning: false }));
    expect(result.output.content).toBe('Checking the calendar.\nFound it: the dentist visit is Monday.');
    expect(result.output.tool_calls).toBeUndefined();
    expect(result.tool_markup).toBeUndefined();
  });

  it('holds a Hermes-shaped tool call in the answer back, never runs it, and reports it leaked', async () => {
    mockContentStream([
      'Let me look that up.\n',
      '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}}</tool_call>',
    ]);
    const result = await modelClient().createNonStream(request({ reasoning: false }));
    expect(result.output.content).toBe('Let me look that up.\n');
    expect(result.output.tool_calls).toBeUndefined();
    expect(result.tool_markup).toBe('leaked');
  });

  it('holds back a call that cannot be parsed and returns no text for it', async () => {
    mockContentStream(['<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}</tool_call>']);
    const result = await modelClient().createNonStream(request({ reasoning: false }));
    expect(result.output.content).toBeNull();
    expect(result.output.tool_calls).toBeUndefined();
    expect(result.tool_markup).toBe('leaked');
  });

  it('keeps the text before an unparseable call and drops the call', async () => {
    mockContentStream([
      'Here is the list.\n',
      '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-1"}</tool_call>',
    ]);
    const result = await modelClient().createNonStream(request({ reasoning: false }));
    expect(result.output.content).toBe('Here is the list.\n');
    expect(result.output.tool_calls).toBeUndefined();
    expect(result.tool_markup).toBe('leaked');
  });

  it('keeps the answer and drops leaked markup from a reply with reasoning and a stray closing tag', async () => {
    mockContentStream([
      'Wait ID? Actually we need the ID',
      ' from create_space response.',
      '</th',
      'ink>\n',
      'Let me check.\n',
      '</tool',
      '_call>\n',
      '<tool',
      '_call>{"name": "get_space", "arguments": ',
      '{"space_id"',
      '</tool_call>',
    ]);
    const result = await modelClient().createNonStream(request({ reasoning: true }));
    const content = typeof result.output.content === 'string' ? result.output.content : '';
    expect(content).toBe('Let me check.\n');
    for (const marker of RAW_MARKERS) {
      expect(content).not.toContain(marker);
    }
    expect(result.output.tool_calls).toBeUndefined();
    expect(result.tool_markup).toBe('leaked');
    expect(JSON.stringify(result.output.thinking_blocks)).toContain('Wait ID? Actually we need the ID');
  });
});
