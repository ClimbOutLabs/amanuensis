/**
 * `logger` is a required key on `contextCompaction()`'s options, checked at compile
 * time: it may be explicitly `undefined`, but omitting the key entirely must not compile.
 */
import { contextCompaction } from '../../../../src/core/capabilities/builtins/ContextCompaction';
import type { AgentDefinition } from '../../../../src/core/runtime/AgentDefinition';
import { makeMockILLM, makeSilentLogger } from '../../harnessMocks';

const definition: AgentDefinition = {
  modelId: undefined,
  configuredModels: undefined,
  modelClient: makeMockILLM(),
};

// Explicit `undefined` is a valid, required value for `logger` — this compiles.
const _withExplicitUndefinedLogger = contextCompaction({ definition, logger: undefined });
// A real logger is equally valid.
const _withLogger = contextCompaction({ definition, logger: makeSilentLogger() });
void _withExplicitUndefinedLogger;
void _withLogger;

// @ts-expect-error `logger` is a required key — callers may not omit it entirely
const _withoutLogger = contextCompaction({ definition });
void _withoutLogger;

describe('contextCompaction logger option type', () => {
  it('compiles only when logger is explicitly provided (a value or undefined)', () => {
    expect(true).toBe(true);
  });
});
