import type { ToolOutputScreenDecision } from '../../schemas/toolOutputScreen';
import type { InstructionBuilder } from '../InstructionBuilder';
import type { IToolSet } from '../mcp/IMCPServer';
import type { ToolBundleName } from '../runtime/toolBundleCatalog';
import type {
  PostToolCallAgentContextProcessor,
  PreLLMAgentContextProcessor,
  PreLLMEphemeralAgentContextProcessor,
  PreSendContextProcessor,
} from './AgentContextProcessor';
import type { ToolResponseProcessor } from './ToolResponseProcessor';

/**
 * JSON-serializable value. Excludes `undefined` — durability is jsonb/JSON, so
 * clears use `null` and absent data omits the key or the map.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Cross-turn capability KV map. Keys: capability.state.key; `tfy.` reserved for builtins. */
export type CapabilityState = Record<string, JsonValue>;

/** Screens untrusted text that reaches the model outside a tool result, such as text read from an uploaded file. */
export interface UntrustedTextScreen {
  screenText(input: { text: string; signal: AbortSignal | undefined }): Promise<ToolOutputScreenDecision>;
}

export interface AgentCapability {
  readonly systemToolSets?: readonly IToolSet[] | undefined;
  readonly preSendProcessors?: readonly PreSendContextProcessor[] | undefined;
  readonly preLLMProcessors?: readonly PreLLMAgentContextProcessor[] | undefined;
  readonly preLLMEphemeralProcessors?: readonly PreLLMEphemeralAgentContextProcessor[] | undefined;
  readonly postToolCallProcessors?: readonly PostToolCallAgentContextProcessor[] | undefined;
  readonly toolResponseProcessors?: readonly ToolResponseProcessor[] | undefined;
  readonly untrustedTextScreens?: readonly UntrustedTextScreen[] | undefined;
  readonly instructionBuilders?: readonly ((builder: InstructionBuilder) => void)[] | undefined;
  /** The bundle whose prompt sections `instructionBuilders` write: sent only while it is loaded. Absent: always sent. */
  readonly bundle?: ToolBundleName | undefined;
  /**
   * Cross-turn durable state. `key` must be unique across capabilities on a
   * thread (`tfy.` reserved for builtins). `load` hydrates from the previous
   * turn's capability_state; writes go through CAPABILITY_STATE events.
   */
  readonly state?: { key: string; load(state: JsonValue): void };
}
