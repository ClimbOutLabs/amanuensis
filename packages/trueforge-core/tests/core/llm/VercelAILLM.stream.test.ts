/**
 * Stream processing: usage/finish-reason normalisation and the
 * TextStreamPart → ExtendedChatCompletionChunk mapper.
 */
import type {
  FinishReason,
  LanguageModelUsage,
  ProviderMetadata,
  StepResultPerformance,
  TextStreamPart,
  ToolSet,
} from 'ai';
import { APICallError } from 'ai';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import {
  chunkHasSubstance,
  chunkSubstanceField,
  describeStreamError,
  enforceStreamDeadlines,
  isContextLengthError,
  mapFinishReason,
  mapStreamToChunks,
  ModelOutputRepetitionError,
  ModelStreamFault,
  normalizeUsage,
  rawChunkProgressField,
  toolCallPieceOf,
  toStreamError,
} from '../../../src/core/llm/VercelAILLM';

// ─────────── Helpers ───────────

function makeUsage(inputTokens = 10, outputTokens = 5): LanguageModelUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: undefined },
    outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
  };
}

function makeFinishStep(
  finishReason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other',
  usage: LanguageModelUsage = makeUsage(),
): TextStreamPart<ToolSet> {
  const performance: StepResultPerformance = {
    effectiveOutputTokensPerSecond: 0,
    outputTokensPerSecond: undefined,
    inputTokensPerSecond: undefined,
    effectiveTotalTokensPerSecond: 0,
    stepTimeMs: 0,
    responseTimeMs: 0,
    toolExecutionMs: {},
    timeToFirstOutputMs: undefined,
  };
  return {
    type: 'finish-step',
    response: { id: 'resp', timestamp: new Date(0), modelId: 'test-model' },
    usage,
    performance,
    finishReason,
    rawFinishReason: undefined,
    providerMetadata: undefined,
  };
}

async function* makeStream(parts: TextStreamPart<ToolSet>[]): AsyncGenerator<TextStreamPart<ToolSet>> {
  for (const part of parts) yield part;
}

async function drainStream(
  gen: AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>,
): Promise<{ chunks: ExtendedChatCompletionChunk[]; final: RawAssistantMessageWithUsage }> {
  const chunks: ExtendedChatCompletionChunk[] = [];
  let result = await gen.next();
  while (!result.done) {
    chunks.push(result.value);
    result = await gen.next();
  }
  return { chunks, final: result.value };
}

const CHUNK_META = { id: 'test-id', created: 0, model: 'test-model' };

// ─────────── normalizeUsage ───────────

describe('normalizeUsage', () => {
  it('sums input and output tokens', () => {
    const result = normalizeUsage(makeUsage(10, 5));
    expect(result).toMatchObject({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('treats undefined token counts as 0', () => {
    const usage = makeUsage(0, 0);
    // Overwrite at runtime to simulate the SDK returning undefined for token counts.
    Reflect.set(usage, 'inputTokens', undefined);
    Reflect.set(usage, 'outputTokens', undefined);
    const result = normalizeUsage(usage);
    expect(result).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });

  it('maps cache and reasoning detail fields', () => {
    const usage = makeUsage(20, 10);
    usage.inputTokenDetails.cacheReadTokens = 5;
    usage.inputTokenDetails.cacheWriteTokens = 3;
    usage.outputTokenDetails.reasoningTokens = 4;
    const result = normalizeUsage(usage);
    expect(result.cache_read_tokens).toBe(5);
    expect(result.cache_write_tokens).toBe(3);
    expect(result.reasoning_tokens).toBe(4);
  });

  it.each([
    ['null', { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: null }],
    ['missing', { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }],
  ])('does not report compatible-provider cache reads when prompt token details are %s', (_detailState, raw) => {
    const usage = makeUsage(20, 10);
    // The compatible SDK currently normalizes absent per-request telemetry to zero.
    usage.inputTokenDetails.cacheReadTokens = 0;
    usage.raw = raw;

    expect(normalizeUsage(usage).cache_read_tokens).toBeUndefined();
  });

  it('preserves compatible-provider cached_tokens from the raw usage payload', () => {
    const usage = makeUsage(20, 10);
    usage.inputTokenDetails.cacheReadTokens = 0;
    usage.raw = {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 12 },
    };

    expect(normalizeUsage(usage).cache_read_tokens).toBe(12);
  });

  it('retains normalized cache usage for non-compatible providers', () => {
    const usage = makeUsage(20, 10);
    usage.inputTokenDetails.cacheReadTokens = 7;
    usage.raw = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };

    expect(normalizeUsage(usage).cache_read_tokens).toBe(7);
  });

  it('retains a positive normalized cache value when raw prompt token details are unavailable', () => {
    const usage = makeUsage(20, 10);
    usage.inputTokenDetails.cacheReadTokens = 7;
    usage.raw = {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_tokens_details: null,
    };

    expect(normalizeUsage(usage).cache_read_tokens).toBe(7);
  });

  it('leaves optional fields as undefined when source values are absent', () => {
    const result = normalizeUsage(makeUsage());
    expect(result.cache_read_tokens).toBeUndefined();
    expect(result.cache_write_tokens).toBeUndefined();
    expect(result.reasoning_tokens).toBeUndefined();
    expect(result.cost_in_usd).toBeUndefined();
  });

  it('maps gateway costInUSD from usage.raw onto cost_in_usd', () => {
    const usage = makeUsage(10, 5);
    usage.raw = { costInUSD: 0.0042 };
    expect(normalizeUsage(usage).cost_in_usd).toBe(0.0042);
  });

  it('omits cost_in_usd when raw.costInUSD is not a nonnegative number', () => {
    const usage = makeUsage();
    usage.raw = { costInUSD: -0.01 };
    expect(normalizeUsage(usage).cost_in_usd).toBeUndefined();
  });
});

// ─────────── mapFinishReason ───────────

describe('mapFinishReason', () => {
  const cases: Array<[FinishReason, string]> = [
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool-calls', 'tool_calls'],
    ['content-filter', 'content_filter'],
    ['error', 'stop'],
    ['other', 'stop'],
  ];

  it.each(cases)('maps %s → %s', (sdkReason, harnessReason) => {
    expect(mapFinishReason(sdkReason)).toBe(harnessReason);
  });
});

// ─────────── describeStreamError ───────────

describe('describeStreamError', () => {
  describe('APICallError', () => {
    it.each([
      {
        provider: 'openai',
        statusCode: 401,
        message: 'Incorrect API key provided: sk-inval***********-key.',
        expected: 'Request failed (401): Incorrect API key provided: sk-inval***********-key.',
      },
      {
        provider: 'anthropic',
        statusCode: 401,
        message: 'invalid x-api-key',
        expected: 'Request failed (401): invalid x-api-key',
      },
      {
        provider: 'google-gemini',
        statusCode: 400,
        message: 'API key not valid. Please pass a valid API key.',
        expected: 'Request failed (400): API key not valid. Please pass a valid API key.',
      },
    ] as const)('includes HTTP status for $provider invalid-key failures', ({ statusCode, message, expected }) => {
      expect(
        describeStreamError(
          new APICallError({
            message,
            url: 'https://example.com',
            requestBodyValues: {},
            statusCode,
          }),
        ),
      ).toBe(expected);
    });

    it('omits status prefix when statusCode is absent', () => {
      expect(
        describeStreamError(
          new APICallError({
            message: 'upstream failed',
            url: 'https://example.com',
            requestBodyValues: {},
          }),
        ),
      ).toBe('upstream failed');
    });
  });

  describe('fallback', () => {
    it('uses Error.message', () => {
      expect(describeStreamError(new Error('upstream error'))).toBe('upstream error');
    });

    it('uses a plain object message field', () => {
      expect(describeStreamError({ message: 'The requested model does not exist.' })).toBe(
        'The requested model does not exist.',
      );
    });

    it('JSON-serialises a message-less object instead of [object Object]', () => {
      expect(describeStreamError({ code: 'model_not_found', status: 404 })).toBe(
        '{"code":"model_not_found","status":404}',
      );
    });

    it('stringifies non-object values', () => {
      expect(describeStreamError('string error')).toBe('string error');
      expect(describeStreamError(42)).toBe('42');
      expect(describeStreamError(null)).toBe('null');
    });
  });
});

describe('toStreamError', () => {
  it('returns Error instances unchanged', () => {
    const err = new Error('keep me');
    err.name = 'AbortError';
    expect(toStreamError(err)).toBe(err);
  });

  it('wraps plain objects using describeStreamError', () => {
    const wrapped = toStreamError({ message: 'The requested model does not exist.' });
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('The requested model does not exist.');
    expect(wrapped.cause).toEqual({ message: 'The requested model does not exist.' });
  });
});

// ─────────── mapStreamToChunks ───────────

describe('mapStreamToChunks', () => {
  it('stops sustained repetition in the reasoning stream', async () => {
    const repeated = `${'the same uncertain identification keeps circling without reaching a useful conclusion '.repeat(45)}.`;
    // Two parts: ~810 words of pure repetition with zero output progress,
    // past the progress window, so the guard must trip.
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'reasoning-delta', id: 'r1', text: repeated },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
    ];

    await expect(drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }))).rejects.toEqual(
      new ModelOutputRepetitionError(),
    );
  });

  it('stops a reply that repeats one sentence three times, keeps the first two, and says so', async () => {
    const sentence = 'Let me know if you need anything else. ';
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-delta', id: 't1', text: sentence.repeat(5) },
      makeFinishStep('stop'),
    ];

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    expect(final.repetition_stopped).toBe(true);
    expect(final.output.content).toBe(`${sentence.repeat(2).trimEnd()}\n\nStopped: the reply was repeating itself.`);
  });

  it('stops a closing-line loop before its third copy, so two copies and the stop line remain', async () => {
    const closing = 'All set for the calendar work tomorrow, see you then.\n';
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-delta', id: 't1', text: 'Here is the summary of the calendar work.\n' },
      ...Array.from({ length: 6 }, () => ({ type: 'text-delta' as const, id: 't1', text: closing })),
    ];

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    expect(final.repetition_stopped).toBe(true);
    expect(final.output.content).toBe(
      `Here is the summary of the calendar work.\n${closing.repeat(2)}\nStopped: the reply was repeating itself.`,
    );
  });

  it('leaves a normal long answer with a few repeated words untouched', async () => {
    const answer = [
      'Your week is busy. Monday has the dentist at 9, and Tuesday is free until lunch.',
      'Let me know if you need anything else.',
      'Wednesday has two meetings, and the review is moved to Thursday morning.',
      'Let me know if you need anything else.',
      'Thursday also has the planning session, which runs long.',
      '',
    ].join('\n');
    const parts: TextStreamPart<ToolSet>[] = [{ type: 'text-delta', id: 't1', text: answer }, makeFinishStep('stop')];

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    expect(final.repetition_stopped).toBeUndefined();
    expect(final.output.content).toBe(answer);
  });

  it('leaves two identical short lines in a row untouched', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-delta', id: 't1', text: 'Done.\nDone.\n' },
      makeFinishStep('stop'),
    ];

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    expect(final.repetition_stopped).toBeUndefined();
    expect(final.output.content).toBe('Done.\nDone.\n');
  });

  it('stops a third identical line of six or more words and says so', async () => {
    const line = 'Please check the build output again.\n';
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-delta', id: 't1', text: line.repeat(3) },
      makeFinishStep('stop'),
    ];

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    expect(final.repetition_stopped).toBe(true);
    expect(final.output.content).toBe(`${line.repeat(2)}\nStopped: the reply was repeating itself.`);
  });

  it('does not stop repetitive reasoning while the turn keeps issuing tool calls', async () => {
    // The observed false positive: methodical per-row reasoning between
    // Space writes, killed as a stuck loop.
    const repeated = `${'the same uncertain identification keeps circling without reaching a useful conclusion '.repeat(45)}.`;
    const parts: TextStreamPart<ToolSet>[] = [{ type: 'reasoning-start', id: 'r1' }];
    for (let call = 0; call < 3; call += 1) {
      parts.push({ type: 'reasoning-delta', id: 'r1', text: repeated });
      parts.push({ type: 'tool-input-start', id: `call-${String(call)}`, toolName: 'write_space_section' });
    }
    parts.push(makeFinishStep('tool-calls'));

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    expect(final.output.tool_calls).toHaveLength(3);
  });

  it('does not stop repetitive reasoning while answer text keeps flowing', async () => {
    const repeated = `${'the same uncertain identification keeps circling without reaching a useful conclusion '.repeat(45)}.`;
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', text: repeated },
          { type: 'text-delta', id: 't1', text: 'Here is the first part of the report.' },
          { type: 'reasoning-delta', id: 'r1', text: repeated },
          { type: 'text-delta', id: 't1', text: 'Here is the second part of the report.' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.content).toContain('second part of the report');
  });

  it('still stops repetitive reasoning when the last progress was long ago', async () => {
    const repeated = `${'the same uncertain identification keeps circling without reaching a useful conclusion '.repeat(45)}.`;
    // One tool call up front, then ~1200 words of pure repetitive reasoning:
    // far past the progress window, so the guard must still trip.
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'tool-input-start', id: 'call-0', toolName: 'write_space_section' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
    ];

    await expect(drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }))).rejects.toEqual(
      new ModelOutputRepetitionError(),
    );
  });

  it('does not stop a ~200-row methodical build streaming row arguments', async () => {
    // The full-report journey: one create_document_report call whose rows
    // stream in as tool-input-deltas, with a per-row reasoning block between
    // them. Each block is long enough that its shingles repeat past the
    // detector's minimum distance, so without progress credit the guard would
    // mistake the build for a stuck loop; argument deltas are real output
    // progress, so the whole ~200-row build must finish.
    const rowReasoning = (row: number): string =>
      `Considering row ${String(row)} of the financial plan, the dividend income line item needs its ` +
      `value checked against the brokerage statement, the same uncertain identification keeps circling ` +
      `while the source line is located, and once the amount is confirmed the row is appended to the ` +
      `arguments for the report tool call that is being constructed incrementally. `;
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'tool-input-start', id: 'call-0', toolName: 'create_document_report' },
      { type: 'reasoning-start', id: 'r1' },
    ];
    for (let row = 0; row < 200; row += 1) {
      parts.push({ type: 'reasoning-delta', id: 'r1', text: rowReasoning(row) });
      parts.push({ type: 'tool-input-delta', id: 'call-0', delta: `{"label":"Row ${String(row)}","value":"$1.00"},` });
    }
    parts.push(makeFinishStep('tool-calls'));

    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    const toolCalls = final.output.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0]?.function.arguments).toContain('Row 199');
  });

  it('still stops a repetitive loop that streams empty tool-input deltas', async () => {
    // Empty deltas (keepalives, not argument content) are not progress: a
    // stuck reasoning loop must still trip even while they flow.
    const repeated = `${'the same uncertain identification keeps circling without reaching a useful conclusion '.repeat(45)}.`;
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'tool-input-start', id: 'call-0', toolName: 'create_document_report' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
      { type: 'tool-input-delta', id: 'call-0', delta: '' },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
      { type: 'tool-input-delta', id: 'call-0', delta: '' },
      { type: 'reasoning-delta', id: 'r1', text: repeated },
    ];

    await expect(drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }))).rejects.toEqual(
      new ModelOutputRepetitionError(),
    );
  });

  it('allows a long reasoning stream that continues to introduce new information', async () => {
    const distinctReasoning = `${Array.from({ length: 400 }, (_, index) => `concept${String(index)}`).join(' ')}.`;
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', text: distinctReasoning },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'text-delta', id: 't1', text: 'Done.' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.content).toBe('Done.');
    expect(final.output.thinking_blocks?.[0]).toMatchObject({ thinking: distinctReasoning });
  });

  it('emits text-delta chunks and accumulates content in the final message', async () => {
    const { chunks, final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'text-delta', id: 't1', text: 'hel' },
          { type: 'text-delta', id: 't1', text: 'lo' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    const textChunks = chunks.filter(c => c.choices[0]?.delta.content !== undefined);
    expect(textChunks).toHaveLength(2);
    expect(textChunks[0]?.choices[0]?.delta.content).toBe('hel');
    expect(textChunks[1]?.choices[0]?.delta.content).toBe('lo');
    expect(final.output.content).toBe('hello');
  });

  it('emits reasoning-delta chunks and accumulates thinking_blocks', async () => {
    const { chunks, final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', text: 'step one' },
          { type: 'reasoning-end', id: 'r1' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    const reasoningChunks = chunks.filter(c => c.choices[0]?.delta.reasoning_content !== undefined);
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0]?.choices[0]?.delta.reasoning_content).toBe('step one');
    expect(final.output.thinking_blocks).toEqual([{ type: 'thinking', thinking: 'step one' }]);
  });

  it('attaches signature from providerMetadata.*.reasoningEncryptedContent on reasoning-end (OpenAI)', async () => {
    const providerMetadata: ProviderMetadata = { openai: { reasoningEncryptedContent: 'enc-sig' } };
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', text: 'thought' },
          { type: 'reasoning-end', id: 'r1', providerMetadata },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks?.[0]).toMatchObject({
      type: 'thinking',
      thinking: 'thought',
      signature: 'enc-sig',
    });
  });

  it('attaches signature from providerMetadata.*.signature on reasoning-end (Anthropic)', async () => {
    const providerMetadata: ProviderMetadata = { anthropic: { signature: 'ant-sig' } };
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', text: 'thought' },
          { type: 'reasoning-end', id: 'r1', providerMetadata },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks?.[0]).toMatchObject({
      type: 'thinking',
      thinking: 'thought',
      signature: 'ant-sig',
    });
  });

  // OpenAI's real wire shape once summaries are on: one reasoning item arrives as several summary
  // parts, each closed with the item's single token. A block per part would replay that one item
  // once per part, all copies carrying the same token with the summary divided between them.
  it('keeps the summary parts of one OpenAI reasoning item in a single block', async () => {
    const itemId = 'rs_abc';
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: `${itemId}:0`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-delta', id: `${itemId}:0`, text: 'first summary' },
          {
            type: 'reasoning-end',
            id: `${itemId}:0`,
            providerMetadata: { openai: { itemId, reasoningEncryptedContent: 'enc-item' } },
          },
          { type: 'reasoning-start', id: `${itemId}:1`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-delta', id: `${itemId}:1`, text: 'second summary' },
          {
            type: 'reasoning-end',
            id: `${itemId}:1`,
            providerMetadata: { openai: { itemId, reasoningEncryptedContent: 'enc-item' } },
          },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'first summary\n\nsecond summary', signature: 'enc-item' },
    ]);
  });

  // The same grouping has to hold when only the closing part carries the token, which is how the
  // provider behaved before it began repeating it, and all a stream is contractually promised.
  it('signs the whole item when only its closing part carries the token', async () => {
    const itemId = 'rs_abc';
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: `${itemId}:0`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-delta', id: `${itemId}:0`, text: 'first summary' },
          { type: 'reasoning-end', id: `${itemId}:0`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-start', id: `${itemId}:1`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-delta', id: `${itemId}:1`, text: 'second summary' },
          {
            type: 'reasoning-end',
            id: `${itemId}:1`,
            providerMetadata: { openai: { itemId, reasoningEncryptedContent: 'enc-sig' } },
          },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'first summary\n\nsecond summary', signature: 'enc-sig' },
    ]);
  });

  // An item can open a summary part it never writes to, which must not push the reasoning that
  // follows behind a blank line.
  it('does not indent the text of an item whose first part is empty', async () => {
    const itemId = 'rs_abc';
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: `${itemId}:0`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-end', id: `${itemId}:0`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-start', id: `${itemId}:1`, providerMetadata: { openai: { itemId } } },
          { type: 'reasoning-delta', id: `${itemId}:1`, text: 'the only summary' },
          {
            type: 'reasoning-end',
            id: `${itemId}:1`,
            providerMetadata: { openai: { itemId, reasoningEncryptedContent: 'enc-item' } },
          },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'the only summary', signature: 'enc-item' },
    ]);
  });

  it('keeps separate reasoning items in separate blocks, each with its own token', async () => {
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'rs_1:0', providerMetadata: { openai: { itemId: 'rs_1' } } },
          { type: 'reasoning-delta', id: 'rs_1:0', text: 'before the tool call' },
          {
            type: 'reasoning-end',
            id: 'rs_1:0',
            providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc-1' } },
          },
          { type: 'reasoning-start', id: 'rs_2:0', providerMetadata: { openai: { itemId: 'rs_2' } } },
          { type: 'reasoning-delta', id: 'rs_2:0', text: 'after the tool call' },
          {
            type: 'reasoning-end',
            id: 'rs_2:0',
            providerMetadata: { openai: { itemId: 'rs_2', reasoningEncryptedContent: 'enc-2' } },
          },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'before the tool call', signature: 'enc-1' },
      { type: 'thinking', thinking: 'after the tool call', signature: 'enc-2' },
    ]);
  });

  // Anthropic's real wire shape: signature_delta surfaces as a text-less reasoning-delta, not on
  // reasoning-end. Missing it leaves the block unsigned, and Anthropic drops unsigned thinking
  // blocks when they are replayed, silently losing the reasoning chain.
  it('attaches signature from a text-less reasoning-delta (Anthropic signature_delta)', async () => {
    const providerMetadata: ProviderMetadata = { anthropic: { signature: 'ant-delta-sig' } };
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', text: 'thought' },
          { type: 'reasoning-delta', id: 'r1', text: '', providerMetadata },
          { type: 'reasoning-end', id: 'r1' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks?.[0]).toMatchObject({
      type: 'thinking',
      thinking: 'thought',
      signature: 'ant-delta-sig',
    });
  });

  it('keeps a reasoning-delta that arrives without a reasoning-start, along with its signature', async () => {
    const providerMetadata: ProviderMetadata = { anthropic: { signature: 'orphan-sig' } };
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'reasoning-delta', id: 'r1', text: 'unopened thought', providerMetadata },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'unopened thought', signature: 'orphan-sig' },
    ]);
  });

  it('drops a tool-input-delta whose id never opened, rather than crediting tool call 0', async () => {
    const { chunks } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'tool-input-start', id: 'call-a', toolName: 'tool_a' },
          { type: 'tool-input-delta', id: 'call-a', delta: '{"city":' },
          { type: 'tool-input-delta', id: 'ghost', delta: '"CORRUPT"' },
          { type: 'tool-input-delta', id: 'call-a', delta: '"Paris"}' },
          makeFinishStep('tool-calls'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    const streamedArgs = chunks
      .map(c => c.choices[0]?.delta.tool_calls?.[0]?.function?.arguments)
      .filter(Boolean)
      .join('');
    expect(streamedArgs).toBe('{"city":"Paris"}');
  });

  it('assigns unique ascending indices to interleaved tool-input-* parts', async () => {
    const { chunks } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'tool-input-start', id: 'call-a', toolName: 'tool_a' },
          { type: 'tool-input-start', id: 'call-b', toolName: 'tool_b' },
          { type: 'tool-input-delta', id: 'call-a', delta: '{"k"' },
          { type: 'tool-input-delta', id: 'call-b', delta: '{}' },
          { type: 'tool-input-delta', id: 'call-a', delta: ':1}' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    const startChunks = chunks.filter(c => c.choices[0]?.delta.tool_calls?.[0]?.id !== undefined);
    expect(startChunks).toHaveLength(2);
    const indices = startChunks.map(c => c.choices[0]?.delta.tool_calls?.[0]?.index);
    expect(indices[0]).toBe(0);
    expect(indices[1]).toBe(1);
  });

  it('accumulates tool_calls arguments in the final message', async () => {
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'tool-input-start', id: 'call-1', toolName: 'search' },
          { type: 'tool-input-delta', id: 'call-1', delta: '{"q"' },
          { type: 'tool-input-delta', id: 'call-1', delta: ':"hi"}' },
          makeFinishStep('tool-calls'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.tool_calls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"hi"}' } },
    ]);
    expect(final.finish_reason).toBe('tool_calls');
  });

  it('captures google thoughtSignature from tool-input-start providerMetadata into provider_specific_fields', async () => {
    const providerMetadata: ProviderMetadata = { google: { thoughtSignature: 'google-sig-abc' } };
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'tool-input-start', id: 'call-g', toolName: 'search_tool', providerMetadata },
          { type: 'tool-input-delta', id: 'call-g', delta: '{"q":"test"}' },
          makeFinishStep('tool-calls'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.tool_calls?.[0]).toMatchObject({
      id: 'call-g',
      type: 'function',
      function: { name: 'search_tool', arguments: '{"q":"test"}' },
      provider_specific_fields: { thought_signature: 'google-sig-abc' },
    });
  });

  it('omits provider_specific_fields when no thoughtSignature is present on tool-input-start', async () => {
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'tool-input-start', id: 'call-x', toolName: 'noop' },
          { type: 'tool-input-delta', id: 'call-x', delta: '{}' },
          makeFinishStep('tool-calls'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );

    expect(final.output.tool_calls?.[0]).not.toHaveProperty('provider_specific_fields');
  });

  it('emits a finish chunk with usage and sets the final message finish_reason', async () => {
    const usage = makeUsage(20, 10);
    usage.raw = { costInUSD: 0.12 };
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream([makeFinishStep('length', usage)]), chunkMeta: CHUNK_META }),
    );

    const finishChunk = chunks.find(c => c.choices[0]?.finish_reason !== null);
    expect(finishChunk?.choices[0]?.finish_reason).toBe('length');
    expect(finishChunk?.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      total_tokens: 30,
      cost_in_usd: 0.12,
    });
    expect(final.finish_reason).toBe('length');
    expect(final.usage.cost_in_usd).toBe(0.12);
  });

  it('omits unknown compatible cache usage from the finish chunk and final response', async () => {
    const usage = makeUsage(20, 10);
    usage.inputTokenDetails.cacheReadTokens = 0;
    usage.raw = {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      prompt_tokens_details: null,
    };

    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream([makeFinishStep('stop', usage)]), chunkMeta: CHUNK_META }),
    );

    const finishChunk = chunks.find(chunk => chunk.usage !== undefined);
    expect(finishChunk?.usage?.cache_read_tokens).toBeUndefined();
    expect(final.usage.cache_read_tokens).toBeUndefined();
  });

  it('rejects with the provider message on an error part', async () => {
    const cause = new Error('upstream error');
    await expect(
      drainStream(
        mapStreamToChunks({
          stream: makeStream([{ type: 'error', error: cause }]),
          chunkMeta: CHUNK_META,
        }),
      ),
    ).rejects.toMatchObject({ message: 'upstream error', cause });
  });

  it('classifies a non-API-error stream error part as a retryable ModelStreamFault', async () => {
    // No status code: a transport-level failure (the shape a cut/malformed stream, such as
    // vLLM's mid-response HarmonyError, takes), not a definite provider response.
    const cause = new Error('connection terminated');
    await expect(
      drainStream(
        mapStreamToChunks({
          stream: makeStream([{ type: 'error', error: cause }]),
          chunkMeta: CHUNK_META,
        }),
      ),
    ).rejects.toBeInstanceOf(ModelStreamFault);
  });

  it('keeps a definite provider error (APICallError with a status code) as a plain Error, not a ModelStreamFault', async () => {
    const cause = new APICallError({
      message: 'invalid x-api-key',
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode: 401,
    });
    const rejection: unknown = await drainStream(
      mapStreamToChunks({
        stream: makeStream([{ type: 'error', error: cause }]),
        chunkMeta: CHUNK_META,
      }),
    ).catch((error: unknown) => error);
    expect(rejection).not.toBeInstanceOf(ModelStreamFault);
  });

  it('keeps a provider error carrying data.code as a plain Error, not a ModelStreamFault', async () => {
    // The AI SDK provider error shape (a provider-side 500, for example from a request the
    // provider rejects): a definite provider response, not a broken stream, so the
    // compact-and-retry recovery must not apply.
    const cause = Object.assign(new Error('Internal Server Error'), {
      data: { message: '', type: 'InternalServerError', param: null, code: 500 },
    });
    const rejection: unknown = await drainStream(
      mapStreamToChunks({
        stream: makeStream([{ type: 'error', error: cause }]),
        chunkMeta: CHUNK_META,
      }),
    ).catch((error: unknown) => error);
    expect(rejection).not.toBeInstanceOf(ModelStreamFault);
    expect(rejection).toBeInstanceOf(Error);
  });

  it('raises ModelStreamFault for a provider answer that the prompt is over the context length', async () => {
    // A shorter history can fix this one definite provider answer, so it takes the retry path.
    const cause = Object.assign(new Error("This model's maximum context length is 32768 tokens."), {
      data: { message: '', type: 'BadRequestError', param: null, code: 400 },
    });
    const rejection: unknown = await drainStream(
      mapStreamToChunks({
        stream: makeStream([{ type: 'error', error: cause }]),
        chunkMeta: CHUNK_META,
      }),
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ModelStreamFault);
    expect(isContextLengthError(rejection)).toBe(true);
  });

  it('raises ModelStreamFault when the stream ends with no text, no tool call, and no finish signal', async () => {
    // The shape a provider closing the connection mid-response takes: the stream's own async
    // iterable simply ends, with no 'error' part and nothing thrown.
    await expect(
      drainStream(mapStreamToChunks({ stream: makeStream([]), chunkMeta: CHUNK_META })),
    ).rejects.toBeInstanceOf(ModelStreamFault);
  });

  it('does not raise ModelStreamFault when the stream ends with partial text but no finish signal', async () => {
    // Text was produced, so this is not the "silently ended" signature: left to normal
    // finish-reason handling rather than reclassified as a stream fault.
    const { final } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([{ type: 'text-delta', id: 't1', text: 'partial' }]),
        chunkMeta: CHUNK_META,
      }),
    );
    expect(final.output.content).toBe('partial');
  });

  it('rejects on an abort part rather than returning the partial message as a clean stop', async () => {
    await expect(
      drainStream(
        mapStreamToChunks({
          stream: makeStream([{ type: 'text-delta', id: 't1', text: 'partial' }, { type: 'abort' }]),
          chunkMeta: CHUNK_META,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with describeStreamError output for an APICallError part', async () => {
    const cause = new APICallError({
      message: 'invalid x-api-key',
      url: 'https://example.com',
      requestBodyValues: {},
      statusCode: 401,
    });
    await expect(
      drainStream(
        mapStreamToChunks({
          stream: makeStream([{ type: 'error', error: cause }]),
          chunkMeta: CHUNK_META,
        }),
      ),
    ).rejects.toMatchObject({
      message: 'Request failed (401): invalid x-api-key',
      cause,
    });
  });

  it('rejects with describeStreamError output for a plain-object error part', async () => {
    await expect(
      drainStream(
        mapStreamToChunks({
          stream: makeStream([{ type: 'error', error: { message: 'The requested model does not exist.' } }]),
          chunkMeta: CHUNK_META,
        }),
      ),
    ).rejects.toMatchObject({
      message: 'The requested model does not exist.',
      cause: { message: 'The requested model does not exist.' },
    });
  });

  it('sets chunk metadata (id, model, object) on emitted chunks', async () => {
    const meta = { id: 'vc-test-001', created: 1000, model: 'my-model' };
    const { chunks } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([{ type: 'text-delta', id: 't1', text: 'x' }, makeFinishStep('stop')]),
        chunkMeta: meta,
      }),
    );
    const chunk = chunks[0];
    expect(chunk?.id).toBe('vc-test-001');
    expect(chunk?.model).toBe('my-model');
    expect(chunk?.object).toBe('chat.completion.chunk');
  });

  it('ignores structural/bookkeeping stream parts without emitting chunks', async () => {
    const { chunks } = await drainStream(
      mapStreamToChunks({
        stream: makeStream([
          { type: 'start' },
          { type: 'text-start', id: 't1' },
          { type: 'text-end', id: 't1' },
          { type: 'tool-input-end', id: 'c1' },
          makeFinishStep('stop'),
        ]),
        chunkMeta: CHUNK_META,
      }),
    );
    // Only the finish-step chunk is emitted (no text-delta chunks for structural parts).
    const nonFinishChunks = chunks.filter(c => c.choices[0]?.finish_reason === null);
    expect(nonFinishChunks).toHaveLength(0);
  });
});

// ─────────── chunkHasSubstance ───────────

describe('isContextLengthError', () => {
  it.each([
    "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.",
    'prompt is too long: 210000 tokens > 200000 maximum',
    'Input is too long for requested model.',
    'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
    'context_length_exceeded',
    'input length and `max_tokens` exceed context limit: 198000 + 8192 > 200000, decrease input length or `max_tokens` and try again',
    'The decoder prompt (length 40000) is longer than the maximum model length of 32768.',
    'the request exceeds the available context size, try increasing it',
  ])('recognizes %s', message => {
    expect(isContextLengthError(new Error(message))).toBe(true);
  });

  it('finds the wording in the cause chain and in an API response body', () => {
    expect(isContextLengthError(new ModelStreamFault('broke', { cause: new Error('prompt is too long') }))).toBe(true);
    const apiError = new APICallError({
      message: 'Bad Request',
      url: 'http://localhost',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    });
    expect(isContextLengthError(apiError)).toBe(true);
  });

  it('does not treat a dropped stream or a timeout as a context-length error', () => {
    expect(isContextLengthError(new ModelStreamFault('The model stream ended without any text.'))).toBe(false);
    expect(isContextLengthError(new Error('terminated', { cause: new Error('other side closed') }))).toBe(false);
    expect(isContextLengthError(new Error('Rate limit reached: too many tokens per minute'))).toBe(false);
  });

  it.each([
    'Rate limit reached for requests',
    'Request timed out.',
    'socket hang up',
    'other side closed',
    'read ECONNRESET',
    'Bad Request',
    'Invalid request: messages must not be empty',
  ])('does not recognize %s', message => {
    expect(isContextLengthError(new Error(message))).toBe(false);
  });

  it('does not treat a generic 400 answer as a context-length error', () => {
    const apiError = new APICallError({
      message: 'Bad Request',
      url: 'http://localhost',
      requestBodyValues: {},
      statusCode: 400,
      responseBody: '{"error":{"message":"Invalid value for temperature","type":"invalid_request_error"}}',
    });
    expect(isContextLengthError(apiError)).toBe(false);
  });
});

describe('chunkHasSubstance', () => {
  it('rejects a part with no reader-visible content', () => {
    expect(chunkHasSubstance({ type: 'start' })).toBe(false);
    expect(chunkHasSubstance({ type: 'start-step', request: {}, warnings: [] })).toBe(false);
    expect(chunkHasSubstance({ type: 'text-start', id: 't1' })).toBe(false);
    expect(chunkHasSubstance({ type: 'text-end', id: 't1' })).toBe(false);
  });

  it('rejects a zero-length text or reasoning delta', () => {
    expect(chunkHasSubstance({ type: 'text-delta', id: 't1', text: '' })).toBe(false);
    expect(chunkHasSubstance({ type: 'reasoning-delta', id: 'r1', text: '' })).toBe(false);
  });

  it('rejects a zero-length tool-input delta', () => {
    expect(chunkHasSubstance({ type: 'tool-input-delta', id: 'c1', delta: '' })).toBe(false);
  });

  it('accepts a nonempty text or reasoning delta', () => {
    expect(chunkHasSubstance({ type: 'text-delta', id: 't1', text: 'a' })).toBe(true);
    expect(chunkHasSubstance({ type: 'reasoning-delta', id: 'r1', text: 'a' })).toBe(true);
  });

  it('accepts a nonempty tool-input delta and a tool-input-start', () => {
    expect(chunkHasSubstance({ type: 'tool-input-delta', id: 'c1', delta: '{' })).toBe(true);
    expect(chunkHasSubstance({ type: 'tool-input-start', id: 'c1', toolName: 'tool_a' })).toBe(true);
  });

  it('accepts a step or turn finish, regardless of any accompanying usage', () => {
    expect(chunkHasSubstance(makeFinishStep('stop'))).toBe(true);
  });

  it('accepts a raw chunk whose delta carries text under a field the parser drops', () => {
    const part: TextStreamPart<ToolSet> = {
      type: 'raw',
      rawValue: {
        choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'thinking' }] } }],
      },
    };
    expect(chunkHasSubstance(part)).toBe(true);
    expect(chunkSubstanceField(part)).toBe('reasoning_details');
    expect(rawChunkProgressField(part.rawValue)).toBe('reasoning_details');
  });

  it('accepts a raw chunk whose tool-call arguments are streaming before the call has a name', () => {
    const part: TextStreamPart<ToolSet> = {
      type: 'raw',
      rawValue: {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"body":"<div>' } }] } }],
      },
    };
    expect(chunkHasSubstance(part)).toBe(true);
    expect(chunkSubstanceField(part)).toBe('tool_call_arguments');
  });

  it('rejects a raw chunk that is only a role marker or an empty keepalive', () => {
    const roleOnly: TextStreamPart<ToolSet> = {
      type: 'raw',
      rawValue: { choices: [{ delta: { role: 'assistant' } }] },
    };
    const empty: TextStreamPart<ToolSet> = { type: 'raw', rawValue: { choices: [{ delta: {} }] } };
    const emptyText: TextStreamPart<ToolSet> = {
      type: 'raw',
      rawValue: { choices: [{ delta: { content: '', reasoning_details: [] } }] },
    };
    expect(chunkHasSubstance(roleOnly)).toBe(false);
    expect(chunkHasSubstance(empty)).toBe(false);
    expect(chunkHasSubstance(emptyText)).toBe(false);
    expect(chunkSubstanceField(roleOnly)).toBeUndefined();
  });

  it('rejects a raw chunk that is not an OpenAI-shaped chunk at all', () => {
    const part: TextStreamPart<ToolSet> = { type: 'raw', rawValue: { type: 'content_block_delta' } };
    expect(chunkHasSubstance(part)).toBe(false);
    expect(rawChunkProgressField('not a chunk')).toBeUndefined();
    expect(rawChunkProgressField(null)).toBeUndefined();
  });

  it('names the field a parsed part carried its progress under', () => {
    expect(chunkSubstanceField({ type: 'text-delta', id: 't1', text: 'a' })).toBe('content');
    expect(chunkSubstanceField({ type: 'reasoning-delta', id: 'r1', text: 'a' })).toBe('reasoning');
    expect(chunkSubstanceField({ type: 'tool-input-delta', id: 'c1', delta: '{' })).toBe('tool_call_arguments');
    expect(chunkSubstanceField({ type: 'text-delta', id: 't1', text: '' })).toBeUndefined();
  });
});

// ─────────── enforceStreamDeadlines ───────────

describe('enforceStreamDeadlines', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function collect<T>(gen: AsyncGenerator<T, void, unknown>): Promise<T[]> {
    const out: T[] = [];
    for await (const part of gen) out.push(part);
    return out;
  }

  it('does not arm the per-chunk timer, and keeps the first-chunk timer running, for substance-free parts', async () => {
    async function* stream() {
      yield { type: 'start' } as TextStreamPart<ToolSet>;
      // Two empty heartbeats spaced past chunkMs, but both well inside firstChunkMs.
      await new Promise(resolve => setTimeout(resolve, 30));
      yield { type: 'start-step', request: {}, warnings: [] } as TextStreamPart<ToolSet>;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const deadlineController = new AbortController();
    const draining = collect(
      enforceStreamDeadlines({
        stream: stream(),
        timeout: { firstChunkMs: 1000, chunkMs: 10 },
        hasSubstance: chunkHasSubstance,
        deadlineController,
      }),
    );
    await jest.advanceTimersByTimeAsync(70);
    const parts = await draining;
    expect(parts).toHaveLength(2);
    expect(deadlineController.signal.aborted).toBe(false);
  });

  it('ends the read itself when the provider stream ignores the abort', async () => {
    async function* stream() {
      yield { type: 'start' } as TextStreamPart<ToolSet>;
      // A provider that accepted the request and never ends its stream, abort or not.
      await new Promise(() => undefined);
    }
    const deadlineController = new AbortController();
    const outcome = collect(
      enforceStreamDeadlines({
        stream: stream(),
        timeout: { firstChunkMs: 90_000, chunkMs: 60_000 },
        hasSubstance: chunkHasSubstance,
        deadlineController,
      }),
    ).then(
      () => 'finished',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(90_000);
    await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
  });

  it('aborts with a first-chunk TimeoutError when no substantive part arrives in time', async () => {
    async function* stream() {
      yield { type: 'start' } as TextStreamPart<ToolSet>;
      await new Promise(() => {
        // Never resolves within the test — the deadline is expected to end iteration first.
      });
    }
    const deadlineController = new AbortController();
    const draining = collect(
      enforceStreamDeadlines({
        stream: stream(),
        timeout: { firstChunkMs: 50, chunkMs: 10 },
        hasSubstance: chunkHasSubstance,
        deadlineController,
      }),
    );
    // Observed before the clock moves, so the rejection is never unhandled.
    const outcome = draining.then(
      () => 'finished',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(60);
    expect(deadlineController.signal.aborted).toBe(true);
    expect(deadlineController.signal.reason).toMatchObject({
      name: 'TimeoutError',
      message: expect.stringMatching(/first chunk/i),
    });
    await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
  });

  it('aborts with a chunk TimeoutError once a substantive part has cleared the first-chunk deadline', async () => {
    async function* stream() {
      yield { type: 'text-delta', id: 't1', text: 'a' } as TextStreamPart<ToolSet>;
      await new Promise(() => {
        // Never resolves within the test — the chunk deadline is expected to fire.
      });
    }
    const deadlineController = new AbortController();
    const draining = collect(
      enforceStreamDeadlines({
        stream: stream(),
        timeout: { firstChunkMs: 1000, chunkMs: 20 },
        hasSubstance: chunkHasSubstance,
        deadlineController,
      }),
    );
    // Observed before the clock moves, so the rejection is never unhandled.
    const outcome = draining.then(
      () => 'finished',
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(30);
    expect(deadlineController.signal.aborted).toBe(true);
    expect(deadlineController.signal.reason).toMatchObject({
      name: 'TimeoutError',
      message: expect.stringMatching(/^chunk/i),
    });
    await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
  });

  describe('while a tool call is open', () => {
    const toolCalls = { chunkMs: 180, pieceOf: toolCallPieceOf };
    const opened = { type: 'tool-input-start', id: 'c1', toolName: 'update_space' } as TextStreamPart<ToolSet>;
    const argumentsArrived = { type: 'tool-input-delta', id: 'c1', delta: '{"a":1}' } as TextStreamPart<ToolSet>;
    const completed = { type: 'tool-input-end', id: 'c1' } as TextStreamPart<ToolSet>;

    function guarded({ gapMs, first }: { gapMs: number; first: TextStreamPart<ToolSet> }): {
      deadlineController: AbortController;
      outcome: Promise<unknown>;
    } {
      async function* stream() {
        yield first;
        await new Promise(resolve => setTimeout(resolve, gapMs));
        yield argumentsArrived;
        yield completed;
      }
      const deadlineController = new AbortController();
      const outcome = collect(
        enforceStreamDeadlines({
          stream: stream(),
          timeout: { firstChunkMs: 1000, chunkMs: 60 },
          hasSubstance: chunkHasSubstance,
          substanceField: chunkSubstanceField,
          toolCalls,
          deadlineController,
        }),
      ).then(
        parts => parts,
        (error: unknown) => error,
      );
      return { deadlineController, outcome };
    }

    it('waits the tool-call allowance for the next piece, not the ordinary bound', async () => {
      const { deadlineController, outcome } = guarded({ gapMs: 150, first: opened });
      await jest.advanceTimersByTimeAsync(160);
      await expect(outcome).resolves.toHaveLength(3);
      expect(deadlineController.signal.aborted).toBe(false);
    });

    it('still times out once the silence passes the tool-call allowance', async () => {
      const { deadlineController, outcome } = guarded({ gapMs: 500, first: opened });
      await jest.advanceTimersByTimeAsync(190);
      await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
      expect(deadlineController.signal.reason).toMatchObject({ message: expect.stringContaining('180ms') });
    });

    it('keeps the ordinary bound when the silence comes before any tool piece', async () => {
      const text = { type: 'text-delta', id: 't1', text: 'a' } as TextStreamPart<ToolSet>;
      const { deadlineController, outcome } = guarded({ gapMs: 150, first: text });
      await jest.advanceTimersByTimeAsync(70);
      await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
      expect(deadlineController.signal.reason).toMatchObject({ message: expect.stringContaining('60ms') });
    });

    it('goes back to the ordinary bound once the call has completed', async () => {
      async function* stream() {
        yield opened;
        yield completed;
        yield { type: 'tool-call', toolCallId: 'c1', toolName: 'update_space', input: {} } as TextStreamPart<ToolSet>;
        await new Promise(() => undefined);
      }
      const deadlineController = new AbortController();
      const outcome = collect(
        enforceStreamDeadlines({
          stream: stream(),
          timeout: { firstChunkMs: 1000, chunkMs: 60 },
          hasSubstance: chunkHasSubstance,
          substanceField: chunkSubstanceField,
          toolCalls,
          deadlineController,
        }),
      ).then(
        () => 'finished',
        (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(70);
      await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' });
    });
  });
});

// ─────────── leaked tool-call markup ───────────

describe('mapStreamToChunks leaked tool-call markup', () => {
  function chunkText(chunks: ExtendedChatCompletionChunk[]): string {
    return chunks.map(chunk => chunk.choices[0]?.delta.content ?? '').join('');
  }

  it('holds the DSML call out of the reply, shows only the text before it, and returns no call', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Let me add that for you. ' },
      { type: 'text-delta', id: 't1', text: '<｜DSML｜tool' },
      { type: 'text-delta', id: 't1', text: '_calls><｜DSML｜invoke name="create_event">' },
      {
        type: 'text-delta',
        id: 't1',
        text: '<｜DSML｜parameter name="title" string="true">Dentist</｜DSML｜parameter>',
      },
      {
        type: 'text-delta',
        id: 't1',
        text: '<｜DSML｜parameter name="start" string="false">{"date_time": "2026-10-27T14:30:00", "time_zone": "America/New_York"}</｜DSML｜parameter>',
      },
      { type: 'text-delta', id: 't1', text: '</｜DSML｜invoke></｜DSML｜tool_calls>' },
      { type: 'text-delta', id: 't1', text: ' Done, I added the appointment to your calendar.' },
      { type: 'text-end', id: 't1' },
      makeFinishStep('tool-calls'),
    ];
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }),
    );
    const shown = chunkText(chunks);
    expect(shown).toBe('Let me add that for you. ');
    expect(shown).not.toContain('DSML');
    expect(shown).not.toContain('added the appointment');
    expect(final.tool_markup).toBe('leaked');
    expect(final.output.content).toBe('Let me add that for you. ');
    expect(final.output.tool_calls).toBeUndefined();
  });

  it('holds back the lone DSML parameter line from the owner report, the exact text the model wrote', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Setting the reminder now.\n' },
      {
        type: 'text-delta',
        id: 't1',
        text: '<｜DSML｜parameter name="start" string="true">2026-10-23T09:10</｜DSML｜parameter>',
      },
      { type: 'text-end', id: 't1' },
      makeFinishStep('stop'),
    ];
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }),
    );
    expect(chunkText(chunks)).toBe('Setting the reminder now.\n');
    expect(final.tool_markup).toBe('leaked');
    expect(final.output.tool_calls).toBeUndefined();
  });

  it('holds back an invented function_results block and shows the text before it, nothing after', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Adding it now. ' },
      { type: 'text-delta', id: 't1', text: '<function_results>Event created: Dentist, Oct 27.</function_results>' },
      { type: 'text-delta', id: 't1', text: ' Done, I added the appointment to your calendar.' },
      { type: 'text-end', id: 't1' },
      makeFinishStep('stop'),
    ];
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }),
    );
    expect(chunkText(chunks)).toBe('Adding it now. ');
    expect(final.tool_markup).toBe('leaked');
    expect(final.output.tool_calls).toBeUndefined();
    expect(final.output.content).toBe('Adding it now. ');
  });

  it('streams a reply whose text merely ends near an opener in full', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Use a < b in code, then stop' },
      { type: 'text-delta', id: 't1', text: ' <' },
      { type: 'text-end', id: 't1' },
      makeFinishStep('stop'),
    ];
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }),
    );
    expect(chunkText(chunks)).toBe('Use a < b in code, then stop <');
    expect(final.tool_markup).toBeUndefined();
    expect(final.output.content).toBe('Use a < b in code, then stop <');
  });

  it('streams a sentence that shows a bare invoke tag as an example, byte for byte', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'Use <invoke name="x">' },
      { type: 'text-delta', id: 't1', text: ' to start a call.' },
      { type: 'text-end', id: 't1' },
      makeFinishStep('stop'),
    ];
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }),
    );
    expect(chunkText(chunks)).toBe('Use <invoke name="x"> to start a call.');
    expect(final.tool_markup).toBeUndefined();
    expect(final.output.content).toBe('Use <invoke name="x"> to start a call.');
    expect(final.output.tool_calls).toBeUndefined();
  });

  it('streams a sentence that names the closing results tag, byte for byte', async () => {
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', text: 'The closing tag </function_res' },
      { type: 'text-delta', id: 't1', text: 'ults> ends the block.' },
      { type: 'text-end', id: 't1' },
      makeFinishStep('stop'),
    ];
    const { chunks, final } = await drainStream(
      mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }),
    );
    expect(chunkText(chunks)).toBe('The closing tag </function_results> ends the block.');
    expect(final.tool_markup).toBeUndefined();
    expect(final.output.content).toBe('The closing tag </function_results> ends the block.');
    expect(final.output.tool_calls).toBeUndefined();
  });

  it('keeps a nested-argument call streamed in multi-token pieces exact', async () => {
    // The owner's calendar failure shape: nested start/end blocks and an attendees list whose
    // argument JSON arrives in pieces of several tokens at once. The pieces must concatenate into
    // the exact JSON, or the call downstream is half-formed.
    const pieces = [
      '{"title":"Dentist","start":{"date_time":"2026-10-27T14:30:00","time_zone":"America/New_York"},',
      '"end":{"date_time":"2026-10-27T15:00:00","time_zone":"America/New_York"},',
      '"attendees":[{"email":"sam@example.com","display_name":"Sam"},',
      '{"email":"pat@example.com","display_name":"Pat"}]}',
    ];
    const parts: TextStreamPart<ToolSet>[] = [
      { type: 'tool-input-start', id: 'call-0', toolName: 'create_event' },
      ...pieces.map((delta): TextStreamPart<ToolSet> => ({ type: 'tool-input-delta', id: 'call-0', delta })),
      { type: 'tool-input-end', id: 'call-0' },
      makeFinishStep('tool-calls'),
    ];
    const { final } = await drainStream(mapStreamToChunks({ stream: makeStream(parts), chunkMeta: CHUNK_META }));
    const call = final.output.tool_calls?.[0];
    expect(call?.function.name).toBe('create_event');
    expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({
      title: 'Dentist',
      start: { date_time: '2026-10-27T14:30:00', time_zone: 'America/New_York' },
      end: { date_time: '2026-10-27T15:00:00', time_zone: 'America/New_York' },
      attendees: [
        { email: 'sam@example.com', display_name: 'Sam' },
        { email: 'pat@example.com', display_name: 'Pat' },
      ],
    });
  });
});
