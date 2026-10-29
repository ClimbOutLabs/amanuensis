/**
 * Maps AgentSpec runtime config flags to public harness builtin capabilities.
 * Plan / ask-user-secret stay gateway-side (extraCapabilities on the resolver).
 */
import type { Logger } from 'winston';
import type { AgentCapability } from '../core/capabilities/AgentCapability';
import { askUserQuestion } from '../core/capabilities/builtins/AskUserQuestion';
import { contextCompaction, type CompactionModel } from '../core/capabilities/builtins/ContextCompaction';
import { currentDateTime } from '../core/capabilities/builtins/CurrentDateTime';
import { documentCapability } from '../core/capabilities/builtins/DocumentTools';
import { dynamicSubAgents } from '../core/capabilities/builtins/DynamicSubAgents';
import { ingestionBudgets, largeToolResponse } from '../core/capabilities/builtins/LargeToolResponse';
import { openUI } from '../core/capabilities/builtins/OpenUI';
import { repositoryBindingContext } from '../core/capabilities/builtins/RepositoryBindingContext';
import {
  TaskChecklistRequestState,
  taskChecklist,
  type TaskChecklistAccess,
} from '../core/capabilities/builtins/TaskChecklist';
import { webSearchRendering } from '../core/capabilities/builtins/WebSearchRendering';
import type { AgentDefinition } from '../core/runtime/AgentDefinition';
import type { BoundRepository, Sandbox } from '../core/sandbox/Sandbox';
import type { AgentTracing } from '../core/tracing/AgentTracing';
import type { AgentSpec } from './schemas/agentSpec';

export interface BuiltinsFromSpecInput {
  spec: AgentSpec;
  definition: AgentDefinition;
  /**
   * Compaction role override from ResolvedAgentDefinition.compactionModel.
   * Undefined means compaction inherits definition.modelClient/modelParams —
   * the thread's own model.
   */
  compactionModel: CompactionModel | undefined;
  /** Root thread only — child threads omit interactive builtins. */
  isChild: boolean;
  sandbox: Sandbox | undefined;
  sandboxAvailable: boolean;
  tracing: AgentTracing;
  logger: Logger;
  compactionContext?: TaskChecklistAccess | undefined;
  /**
   * Host instance-wide compaction trigger (from ITurnResourceResolver), used only when the spec
   * sets no compaction trigger; an explicit spec value always wins over this. Undefined leaves
   * the threshold to contextCompaction, which derives it from the model's context length.
   */
  compactionThresholdTokensDefault?: number | undefined;
  boundRepository?: BoundRepository | undefined;
  /** Built-in tool names this run does not offer. */
  withheldTools?: readonly string[] | undefined;
}

export function builtinsFromSpec(input: BuiltinsFromSpecInput): AgentCapability[] {
  const {
    spec,
    definition,
    compactionModel,
    isChild,
    sandbox,
    sandboxAvailable,
    tracing,
    logger,
    compactionContext,
    compactionThresholdTokensDefault,
    boundRepository,
    withheldTools,
  } = input;
  const config = spec.config;
  const checklistState = new TaskChecklistRequestState(compactionContext);
  const capabilities: AgentCapability[] = [
    currentDateTime({ tracing, timezone: definition.clientTimezone }),
    repositoryBindingContext({
      boundRepository,
      sandboxAvailable,
      checklist: isChild ? undefined : compactionContext,
      checklistState,
    }),
    // Renders a search-tool JSON result to compact markdown before the large-tool-response
    // processor's threshold check runs, so a normal-sized search stays a single small result.
    webSearchRendering(),
  ];

  if (!isChild && sandboxAvailable && sandbox !== undefined) {
    capabilities.push(documentCapability({ sandbox, tracing, boundRepository, withheldTools }));
  }

  if (!isChild && compactionContext !== undefined) {
    capabilities.push(taskChecklist({ access: compactionContext, tracing }));
  }

  if (config.context_management.compaction.enabled) {
    capabilities.push(
      contextCompaction({
        definition,
        compactionModel,
        // An explicit spec value always wins; only an unset spec value falls through to the
        // host's instance-wide value, which itself falls through to the context-length ratio.
        compactionThresholdTokens:
          config.context_management.compaction.trigger?.value ?? compactionThresholdTokensDefault,
        checklist: compactionContext,
        checklistState,
        boundRepository,
        logger,
      }),
    );
  }

  if (!isChild && config.ask_user_questions.enabled) {
    capabilities.push(askUserQuestion());
  }

  const dynamicSubAgentsEnabled = config.dynamic_sub_agents.enabled;
  if (!isChild && dynamicSubAgentsEnabled) {
    capabilities.push(
      dynamicSubAgents({
        sandboxAvailable,
        tracing,
      }),
    );
  }

  // Before largeToolResponse: the size thresholds must measure what the budgets leave in the history.
  capabilities.push(ingestionBudgets());

  if (config.context_management.large_tool_response.enabled) {
    capabilities.push(
      largeToolResponse({
        dynamicSubAgentsPresent: !isChild && dynamicSubAgentsEnabled,
        logger,
        tracing,
      }),
    );
  }

  if (!isChild && config.generative_ui.enabled) {
    capabilities.push(openUI({ preload: false, tracing }));
  }

  return capabilities;
}

/**
 * The capabilities a thread runs with: the spec's builtins, then the host's extra capabilities.
 * Root threads, sub-agent threads and the prompt report all assemble through this one function.
 */
export function threadCapabilities({
  extraCapabilities,
  ...input
}: BuiltinsFromSpecInput & { extraCapabilities?: readonly AgentCapability[] | undefined }): AgentCapability[] {
  return [...builtinsFromSpec(input), ...(extraCapabilities ?? [])];
}
