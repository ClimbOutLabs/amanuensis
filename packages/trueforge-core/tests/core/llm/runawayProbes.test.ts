/**
 * SCRATCH PROBES for the runaway-replies diagnosis. Not part of the final PR.
 * Each case logs the observed outcome instead of asserting, so the diagnosis
 * reads off the run.
 */
import { appendFileSync } from 'node:fs';
import type { LLMCreateParams } from '../../../src/core/llm/ILLM';
import { VercelAILLM } from '../../../src/core/llm/VercelAILLM';
import { makeSilentLogger } from '../harnessMocks';

type Finish = 'stop' | 'length' | 'tool_calls';

function frame(delta: Record<string, unknown>, finishReason: Finish | null): string {
  return `data: ${JSON.stringify({
    id: 'tf-synthetic',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'nvidia/nemotron-3-super-120b-a12b',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function mockStream(frames: string[]): { bodies: string[] } {
  const bodies: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    bodies.push(
      `initType=${typeof init} bodyType=${typeof init?.body} body=${typeof init?.body === 'string' ? init.body : '(not a string)'}`,
    );
    const body = `${frames.join('')}data: [DONE]\n\n`;
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  });
  return { bodies };
}

function contentFrames(pieces: string[], finish: Finish): string[] {
  return [frame({ role: 'assistant' }, null), ...pieces.map(piece => frame({ content: piece }, null)), frame({}, finish)];
}

function reasoningFrames(pieces: string[], answer: string, finish: Finish): string[] {
  return [
    frame({ role: 'assistant' }, null),
    ...pieces.map(piece => frame({ reasoning_content: piece }, null)),
    frame({ content: answer }, null),
    frame({}, finish),
  ];
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

function request(extra?: Record<string, unknown>): LLMCreateParams {
  const body: LLMCreateParams = { messages: [{ role: 'user', content: 'Find my dentist appointment.' }] };
  if (extra !== undefined) {
    Object.assign(body, extra);
  }
  return body;
}

async function run(frames: string[], extra?: Record<string, unknown>): Promise<void> {
  try {
    const result = await modelClient().createNonStream(request(extra));
    note(
      JSON.stringify({
        content: result.output.content,
        finish: result.finish_reason,
        toolMarkup: result.tool_markup ?? null,
        repetitionStopped: result.repetition_stopped ?? null,
        toolCalls: result.output.tool_calls?.length ?? 0,
        thinking: result.output.thinking_blocks?.map(block => block.thinking).join('|') ?? null,
      }),
    );
  } catch (error) {
    note(JSON.stringify({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }));
  }
}

function note(text: string): void {
  appendFileSync('/home/hatch/workspace/job-runaway-replies/probe-results.txt', `${text}\n`);
}

describe('probes: symptom 1, cut-off and glued markup', () => {
  afterEach(() => jest.restoreAllMocks());

  it('A1 Hermes opener only, cut at length', async () => {
    mockStream(contentFrames(['Here is the list.\n', '<tool_call>'], 'length'));
    await run(contentFrames(['Here is the list.\n', '<tool_call>'], 'length'));
  });

  it('A2 partial Hermes tag, cut at length', async () => {
    const frames = contentFrames(['Here is the list.\n', '<tool_call'], 'length');
    mockStream(frames);
    await run(frames);
  });

  it('A3 Hermes payload cut after the opening brace, at length', async () => {
    const frames = contentFrames(
      ['Here is the list.\n', '<tool_call>{"name": "get_event", "arguments": {"event_id": "evt-'],
      'length',
    );
    mockStream(frames);
    await run(frames);
  });

  it('A4 closing tag glued to prose, stop', async () => {
    const frames = contentFrames(['Your visit is Monday at 2:30 pm.', '</tool_call>'], 'stop');
    mockStream(frames);
    await run(frames);
  });

  it('A5 closing tag at end of line, more text after, stop', async () => {
    const frames = contentFrames(['Done.</tool_call>', '\nMore text follows here.'], 'stop');
    mockStream(frames);
    await run(frames);
  });

  it('A6 wrapper only, cut at length', async () => {
    const frames = contentFrames(['Working on it.\n', '<tool_calls>'], 'length');
    mockStream(frames);
    await run(frames);
  });

  it('A7 invoke tag only, cut at length', async () => {
    const frames = contentFrames(['Working on it.\n', '<invoke name="get_event">'], 'length');
    mockStream(frames);
    await run(frames);
  });

  it('A8 unclosed fence holding a full call, cut at length', async () => {
    const frames = contentFrames(
      ['Example:\n```\n', '<tool_call>{"name": "get_event", "arguments": {}}</tool_call>'],
      'length',
    );
    mockStream(frames);
    await run(frames);
  });

  it('A9 Hermes opener only, stop (control for A1)', async () => {
    const frames = contentFrames(['Here is the list.\n', '<tool_call>'], 'stop');
    mockStream(frames);
    await run(frames);
  });

  it('A10 DSML invoke tag only, cut at length', async () => {
    const frames = contentFrames(['Working on it.\n', '<｜DSML｜invoke name="get_event">'], 'length');
    mockStream(frames);
    await run(frames);
  });

  it('A11 Hermes tag plus newline, cut at length', async () => {
    const frames = contentFrames(['Working on it.\n', '<tool_call>\n'], 'length');
    mockStream(frames);
    await run(frames);
  });

  it('A12 think block drafting a call, then an answer, stop', async () => {
    const frames = contentFrames(
      [
        '<think>Let me call get_event now. <tool_call>{"name": "get_event", "arguments": {}}</tool_call> That should work.</think>',
        'The visit is on Monday.',
      ],
      'stop',
    );
    mockStream(frames);
    await run(frames, { reasoning_effort: 'high' });
  });

  it('A13 parsed tool call, then a closing tag as content on the same line', async () => {
    const frames = [
      frame({ role: 'assistant' }, null),
      frame({ content: 'Checking the calendar.' }, null),
      frame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'get_event', arguments: '{"event_id":"evt-1"}' },
            },
          ],
        },
        null,
      ),
      frame({ content: '</tool_call>' }, null),
      frame({}, 'tool_calls'),
    ];
    mockStream(frames);
    await run(frames);
  });
});

const SENT_A = 'The dentist appointment is booked for Monday at half past two in the afternoon.';
const SENT_B = 'You will get a reminder one hour before the visit starts that day.';
const SENT_C = 'Bring your insurance card and the list of medicines you take now.';
const PARAGRAPH = `${SENT_A} ${SENT_B} ${SENT_C}`;

describe('probes: symptom 2, repeated paragraph by channel', () => {
  afterEach(() => jest.restoreAllMocks());

  it('B1 answer paragraph verbatim three times, stop', async () => {
    const frames = contentFrames([PARAGRAPH, '\n\n', PARAGRAPH, '\n\n', PARAGRAPH], 'stop');
    mockStream(frames);
    await run(frames);
  });

  it('B2 answer paragraph three times with one word drifting each copy', async () => {
    const drift = (word: string): string => PARAGRAPH.replace('Monday', word);
    const frames = contentFrames([PARAGRAPH, '\n\n', drift('Tuesday'), '\n\n', drift('Wednesday')], 'stop');
    mockStream(frames);
    await run(frames);
  });

  it('B3 answer paragraph verbatim twice, stop', async () => {
    const frames = contentFrames([PARAGRAPH, '\n\n', PARAGRAPH], 'stop');
    mockStream(frames);
    await run(frames);
  });

  it('B4 reasoning paragraph four times (about 160 words), then an answer', async () => {
    const frames = reasoningFrames([PARAGRAPH, PARAGRAPH, PARAGRAPH, PARAGRAPH], 'Done.', 'stop');
    mockStream(frames);
    await run(frames, { reasoning_effort: 'high' });
  });

  it('B5 reasoning paragraph ten times (about 400 words), then an answer', async () => {
    const frames = reasoningFrames(Array.from({ length: 10 }, () => PARAGRAPH), 'Done.', 'stop');
    mockStream(frames);
    await run(frames, { reasoning_effort: 'high' });
  });

  it('B6 answer repeated as list lines three times, stop', async () => {
    const line = '- The dentist visit is on Monday at half past two in the afternoon.';
    const frames = contentFrames([`${line}\n${line}\n${line}\n`], 'stop');
    mockStream(frames);
    await run(frames);
  });
});

describe('probes: symptom 2b, reasoning guard at scale', () => {
  afterEach(() => jest.restoreAllMocks());

  it('B5b reasoning paragraph twenty times (about 800 words), then an answer', async () => {
    const frames = reasoningFrames(Array.from({ length: 20 }, () => PARAGRAPH), 'Done.', 'stop');
    mockStream(frames);
    await run(frames, { reasoning_effort: 'high' });
  });
});

describe('probes: symptom 4, what goes over the wire', () => {
  afterEach(() => jest.restoreAllMocks());

  it('D1 no configured cap: request body token fields', async () => {
    const { bodies } = mockStream(contentFrames(['Hello.'], 'stop'));
    await run(contentFrames(['Hello.'], 'stop'));
    note(`D1 captured: ${bodies[0] ?? '(none)'}`);
  });

  it('D2 configured max_tokens 8192: request body token fields', async () => {
    const { bodies } = mockStream(contentFrames(['Hello.'], 'stop'));
    await run(contentFrames(['Hello.'], 'stop'), { max_tokens: 8192 });
    note(`D2 captured: ${bodies[0] ?? '(none)'}`);
  });
});
