import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import type { DocumentIngestionEvent } from '../../../src/core/events/schema';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentInputUserMessage, FileContentPart } from '../../../src/core/runtime/UserInputMessage';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import '../harnessMocks';
import { makeSilentLogger, makeStubPublicSandbox } from '../harnessMocks';

function dataUri(mime: string, text: string): string {
  return `data:${mime};base64,${Buffer.from(text).toString('base64')}`;
}

function messageFor(files: FileContentPart[]): AgentInputUserMessage {
  return { type: EventType.USER_MESSAGE, content: files };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'done' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeSandboxWithUpload() {
  const sandbox = makeStubPublicSandbox();
  jest
    .spyOn(sandbox, 'uploadUserFile')
    .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
  jest.spyOn(sandbox, 'createDocumentSnapshot').mockImplementation(input =>
    Promise.resolve({
      filePath: input.filePath,
      content: Buffer.from('staged-bytes'),
      verify: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    }),
  );
  return sandbox;
}

/** Resolves each file's native-text extraction after a tick, so `started` and `finished` are
 * genuinely separated in time rather than resolving synchronously within the same microtask. */
function mockExtractionWithTick(sandbox: ReturnType<typeof makeSandboxWithUpload>) {
  return jest.spyOn(sandbox, 'runDocumentText').mockImplementation(
    () =>
      new Promise(resolve => {
        setTimeout(() => resolve({ total_pages: 1, pages: [{ page_number: 1, text: 'extracted body text' }] }), 0);
      }),
  );
}

function makeThread(sandbox: ReturnType<typeof makeSandboxWithUpload>, create: jest.Mock): AgentThread {
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
    context: [],
    sandbox,
  });
}

function ingestionEvents(events: readonly unknown[]): DocumentIngestionEvent[] {
  return events.filter(
    (e): e is DocumentIngestionEvent => (e as { type?: unknown }).type === EventType.DOCUMENT_INGESTION,
  );
}

describe('AgentThread pre-model document ingestion streaming', () => {
  it('yields started before extraction begins and finished after, per file, in order', async () => {
    const sandbox = makeSandboxWithUpload();
    mockExtractionWithTick(sandbox);
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const thread = makeThread(sandbox, create);
    const signal = new AbortController().signal;

    for await (const _e of thread.send(
      [messageFor([{ type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'a') }])],
      signal,
    )) {
      // draining the append is enough
    }

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal })) {
      events.push(event);
    }

    const ingestion = ingestionEvents(events);
    expect(ingestion.map(e => e.phase)).toEqual(['started', 'finished']);
    expect(ingestion[0]?.file_name).toBe('first.pdf');
    expect(ingestion[1]?.file_name).toBe('first.pdf');
    expect(ingestion[1]?.method).toBe('native text');
    expect(ingestion[1]?.page_count).toBe(1);
  });

  it('yields started/finished for every file in order across a multi-file batch', async () => {
    const sandbox = makeSandboxWithUpload();
    mockExtractionWithTick(sandbox);
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const thread = makeThread(sandbox, create);
    const signal = new AbortController().signal;

    for await (const _e of thread.send(
      [
        messageFor([
          { type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'a') },
          { type: 'file', name: 'second.pdf', data: dataUri('application/pdf', 'b') },
        ]),
      ],
      signal,
    )) {
      // draining the append is enough
    }

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal })) {
      events.push(event);
    }

    const ingestion = ingestionEvents(events);
    expect(ingestion.map(e => `${e.file_name}:${e.phase}`)).toEqual([
      'first.pdf:started',
      'first.pdf:finished',
      'second.pdf:started',
      'second.pdf:finished',
    ]);
  });

  it('appends each file extracted text part to the model context', async () => {
    const sandbox = makeSandboxWithUpload();
    mockExtractionWithTick(sandbox);
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const thread = makeThread(sandbox, create);
    const signal = new AbortController().signal;

    for await (const _e of thread.send(
      [messageFor([{ type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'a') }])],
      signal,
    )) {
      // draining
    }
    for await (const _event of thread.execute({ signal })) {
      // draining
    }

    expect(create).toHaveBeenCalled();
    const request = create.mock.calls[0]?.[0] as LLMCreateParamsStreaming | undefined;
    const messages = (request?.messages ?? []) as ChatCompletionMessageParam[];
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('extracted body text');
    expect(serialized).toContain('first.pdf');
  });

  it('never leaves a started file without a terminal event, and cancels files not yet reached, when the signal aborts mid-batch', async () => {
    const sandbox = makeSandboxWithUpload();
    const controller = new AbortController();
    jest.spyOn(sandbox, 'runDocumentText').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            // Extraction's own per-file error handling (documentExtraction.ts) folds an abort
            // that fires mid-extraction into that file's `failed` phase rather than throwing —
            // so this file still gets a terminal event, just not `cancelled`. The abort is only
            // checked again before the *next* file starts, which is where `cancelled` applies.
            controller.abort();
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            reject(error);
          }, 0);
        }),
    );
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const thread = makeThread(sandbox, create);

    for await (const _e of thread.send(
      [
        messageFor([
          { type: 'file', name: 'first.pdf', data: dataUri('application/pdf', 'a') },
          { type: 'file', name: 'second.pdf', data: dataUri('application/pdf', 'b') },
        ]),
      ],
      undefined,
    )) {
      // draining
    }

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: controller.signal })) {
      events.push(event);
    }

    const ingestion = ingestionEvents(events);
    expect(ingestion.map(e => `${e.file_name}:${e.phase}`)).toEqual([
      'first.pdf:started',
      'first.pdf:failed',
      'second.pdf:cancelled',
    ]);
    // second.pdf never started: the abort is caught before its `started` event is yielded.
    expect(ingestion.some(e => e.file_name === 'second.pdf' && e.phase === 'started')).toBe(false);
  });

  it('yields failed with the issue text and continues with the next file', async () => {
    const sandbox = makeSandboxWithUpload();
    let call = 0;
    jest.spyOn(sandbox, 'runDocumentText').mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new Error('OCR backend unavailable'));
      }
      return Promise.resolve({ total_pages: 1, pages: [{ page_number: 1, text: 'second file text' }] });
    });
    const create = jest.fn((_request: LLMCreateParamsStreaming) => finalAnswerStream());
    const thread = makeThread(sandbox, create);
    const signal = new AbortController().signal;

    for await (const _e of thread.send(
      [
        messageFor([
          { type: 'file', name: 'broken.pdf', data: dataUri('application/pdf', 'a') },
          { type: 'file', name: 'ok.pdf', data: dataUri('application/pdf', 'b') },
        ]),
      ],
      signal,
    )) {
      // draining
    }

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal })) {
      events.push(event);
    }

    const ingestion = ingestionEvents(events);
    expect(ingestion.map(e => `${e.file_name}:${e.phase}`)).toEqual([
      'broken.pdf:started',
      'broken.pdf:failed',
      'ok.pdf:started',
      'ok.pdf:finished',
    ]);
    const failed = ingestion.find(e => e.file_name === 'broken.pdf' && e.phase === 'failed');
    expect(failed?.issue).toContain('OCR backend unavailable');
  });
});
