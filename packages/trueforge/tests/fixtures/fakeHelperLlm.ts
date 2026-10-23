import type { ILLM } from '@truefoundry/trueforge-core/core';

/**
 * A complete ILLM double for helper-model tests (summaries, chat titles): the helper jobs only
 * call `createNonStream`, and streaming refuses loudly so an unexpected call fails the test.
 */
export function fakeHelperLlm(content: string | { type: 'text'; text: string }[]): ILLM {
  const result: Awaited<ReturnType<ILLM['createNonStream']>> = {
    output: { role: 'assistant', content },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    finish_reason: 'stop',
  };
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by helper jobs');
    },
    createNonStream: () => Promise.resolve(result),
  };
}

/** An ILLM double whose helper call fails with `error`. */
export function fakeHelperLlmThrowing(error: Error): ILLM {
  return {
    create(): ReturnType<ILLM['create']> {
      throw new Error('streaming is not used by helper jobs');
    },
    createNonStream: () => Promise.reject(error),
  };
}
