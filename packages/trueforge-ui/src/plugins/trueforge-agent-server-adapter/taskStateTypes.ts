/**
 * Wire shape for the task-state budget config.
 *
 * The `task_state` knob is implemented in trueforge-core and the backend
 * AgentSpecSchema, but the generated SDK hasn't been regenerated yet
 * (requires `pnpm sdk:generate` with Docker/Fern). This type carries the
 * snake_case wire shape so the UI adapter can convert between camelCase (UI)
 * and snake_case (wire) in a type-safe way.
 *
 * It extends the strict SDK `RuntimeConfig` (not the looser harness config:
 * the harness leaves `sandbox.enabled` optional while the wire schema
 * requires it, so the adapter normalizes an unset `enabled` to `false` when
 * building this shape).
 *
 * The SDK request serializer uses `unrecognizedObjectKeys: "passthrough"`,
 * so the `task_state` key rides through to the backend at runtime.
 *
 * TODO: Remove after `pnpm sdk:generate` includes task_state in RuntimeConfig.
 */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** SDK RuntimeConfig plus the not-yet-generated `task_state` wire key. */
export interface WireRuntimeConfig extends TrueForgeApi.RuntimeConfig {
  /** Wire-format task-state budget config (snake_case). */
  task_state?: {
    tool_call_budget?: number;
    budgeted_tools?: string[];
  };
}
