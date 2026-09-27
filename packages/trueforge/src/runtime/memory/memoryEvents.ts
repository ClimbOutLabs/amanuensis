/**
 * Re-exports the `aman.memory.recall` passthrough event schemas from schemas/memoryEvents.ts
 * (their canonical, OpenAPI-named home) and registers the event in the harness's passthrough
 * event registry. Existing runtime/memory imports of this module keep working unchanged.
 */
import { MemoryRecallEventSchema } from '../../schemas/memoryEvents';

export {
  MemoryCuratedStatsSchema,
  MemoryLayersStatsSchema,
  MemoryRecallEventSchema,
  MemoryRecallStatsSchema,
  MemoryReflectStatsSchema,
  MemoryScreenRecordSchema,
  MemoryScreenStatsSchema,
  MemorySweepStatsSchema,
} from '../../schemas/memoryEvents';
export type {
  MemoryCuratedStats,
  MemoryLayersStats,
  MemoryRecallEvent,
  MemoryRecallStats,
  MemoryReflectStats,
  MemoryScreenRecord,
  MemoryScreenStats,
  MemorySweepStats,
} from '../../schemas/memoryEvents';

/**
 * Registers `aman.memory.recall` in the harness's passthrough event registry. This targets
 * trueforge-core's internal `PassthroughEvents` module by relative path rather than its public
 * `@truefoundry/trueforge-core/core` entry point: TypeScript's declaration-merging augmentation
 * must resolve to the exact module that declares `AgentPassthroughEventSchemaMap`, and that
 * interface is not re-exported from the package barrel (mirrors the in-repo pattern in
 * trueforge-core's own storeContractSuite.ts, extended across the package boundary). If
 * trueforge-core ever moves this file, this path needs updating alongside it.
 */
declare module '../../../../trueforge-core/src/core/events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'aman.memory.recall': typeof MemoryRecallEventSchema;
  }
}
