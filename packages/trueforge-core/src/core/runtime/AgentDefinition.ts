import type { RootAgentNames } from '../InstructionBuilder';
import type { ILLM } from '../llm/ILLM';
import type { LLMUserMessage } from '../llm/LLMTypes';
import type { ResponseFormat } from '../llm/responseFormat';
import type { IToolSet } from '../mcp/IMCPServer';
import type { ReplyStepBudget } from './replyBudget';

export type ModelParams = Record<string, unknown>;

/**
 * One model the host actually has configured, for the model-identity
 * section's host-owned-facts list. `modelId` is the upstream identifier (as
 * sent to the provider, not the catalog alias); `provider` is the configured
 * provider's resource name.
 */
export interface ConfiguredModelSummary {
  modelId: string;
  provider: string;
}

/**
 * Static definition of an agent. Represents the authored configuration,
 * not the execution state. Inherited by sub-agent definitions.
 *
 * Model identity lives on `modelClient` (e.g. VercelAILLM providerConfig),
 * not as a parallel string on this definition.
 */
export interface AgentDefinition {
  modelClient: ILLM;
  /**
   * Upstream, provider-specific model identifier (e.g. a catalog model's
   * `model_id`, not its catalog `name`/alias), used only to tell the model its
   * own name in the system prompt. Not part of model identity itself, which
   * stays on `modelClient`. Required so every construction site states its
   * intent explicitly; `undefined` for resolvers that cannot supply a real
   * identity (the identity section is then omitted).
   */
  modelId: string | undefined;
  /**
   * Whether the resolved model can read images directly, from the
   * configured model's `properties.vision` (absent means false). Governs
   * how UserInputMessage attaches images: sent as `image_url` parts when
   * true; gated behind a sandbox for OCR otherwise. Required so every
   * construction site states its intent explicitly.
   */
  modelSupportsVision?: boolean;
  /**
   * Models actually configured on this host at turn time (from the model
   * provider store), for the model-identity section's host-owned-facts list:
   * a fact the model can be told outright instead of a behavior it is asked to
   * infer. Required like `modelId` so every construction site states its
   * intent; `undefined`/empty omits the list from the section. Capped by the
   * resolver, not here.
   */
  configuredModels: readonly ConfiguredModelSummary[] | undefined;
  modelProperties?:
    | {
        /** Maximum combined input/output context for the resolved model, when known. */
        contextLength: number | undefined;
      }
    | undefined;
  /**
   * IANA timezone name the client sent with the turn (e.g. via
   * Intl.DateTimeFormat().resolvedOptions().timeZone), used to report local time from
   * get_current_datetime and in the ambient current-date section. Undefined when the client
   * sent none, or the resolver has no client to ask; both the tool and the section fall back
   * to UTC.
   */
  clientTimezone?: string | undefined;
  /**
   * Names for the root assistant's identity section. Omitted or empty values use the default assistant name and
   * the neutral "person you work for" wording. Sub-agent threads ignore it.
   */
  identity?: RootAgentNames | undefined;
  instruction?: string | undefined;
  messages?: readonly LLMUserMessage[] | undefined;
  modelParams?: ModelParams | undefined;
  /** Same wire shape as AgentSpec.response_format (Zod ResponseFormat). */
  responseFormat?: ResponseFormat | undefined;
  iterationLimit?: number | undefined;
  /**
   * Host-owned per-request tool-call budget. When set, the turn gets the
   * task-state scratchpad (fresh `<task_state>` block before every model call,
   * immune to context compaction) plus the `record_finding` tool, and the
   * host withholds the configured budgeted research tools once `toolCallBudget`
   * calls have executed, forcing the final-answer pass. Control, approval,
   * host, and unrelated tools stay available throughout. Undefined (default)
   * disables the whole feature: no block, no tool, no budget. Requires
   * `budgetedTools` when set.
   */
  toolCallBudget?: number | undefined;
  /**
   * Canonical original tool names charged against `toolCallBudget` and
   * withheld once it is spent. Supports `*` wildcards (e.g. `tavily*`).
   * `record_finding` is always exempt and can never be listed. Required when
   * `toolCallBudget` is set; ignored otherwise.
   */
  budgetedTools?: readonly string[] | undefined;
  /**
   * Model calls one reply may make on the main thread and on each sub-agent. Undefined uses the
   * production budget; only tests raise it, to exercise guards that need longer replies.
   */
  stepBudget?: ReplyStepBudget | undefined;

  toolSets?: readonly IToolSet[] | undefined;
  /**
   * Offers the model no tools at all, neither connector tools nor built-in ones such as
   * schedules, files or checklists. For an agent that may only answer from what it already knows.
   */
  readOnly?: boolean | undefined;
}
