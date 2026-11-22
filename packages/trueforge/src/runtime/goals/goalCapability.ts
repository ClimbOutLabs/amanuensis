/**
 * The goal tools a chat turn carries. They run over the same goal service as
 * the Goals API, with the chat's owner and persona, so a goal made in a chat
 * and a goal made on the Goals page are the same goal.
 *
 * A tool can make a draft and ask for a check. Activation is not a tool: it is
 * the owner's own gesture on the activation card, so a draft made here waits
 * for the owner to review and activate it there.
 */
import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability, AgentTracing, InstructionBuilder } from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import {
  CREATE_GOAL_TOOL_NAME,
  GET_GOAL_TOOL_NAME,
  GOALS_SERVER_ID,
  LIST_GOALS_TOOL_NAME,
  REQUEST_GOAL_CHECK_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/goals/toolContract';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { IAgentStore } from '../../db/agentStore';
import type { ISkillStore } from '../../db/skillStore';
import type { ISpaceStore } from '../../db/spaceStore';
import { toolsForChat } from '../privateChat';
import { runManualCheck } from './goalCheck';
import {
  createGoalService,
  GoalNotFoundError,
  GoalSetupChangedError,
  GoalStateError,
  nextStepOf,
  type GoalActor,
  type GoalService,
} from './goalService';
import type { IGoalStore } from './goalStorePort';
import { chainGoalSourceReaders, createSpaceGoalSourceReader } from './spaceGoalSourceReader';

/** What a goal tool needs from the host for one chat turn. */
export interface GoalTurnContext {
  store: IGoalStore<unknown>;
  agentStore: Pick<IAgentStore<unknown>, 'getAgent'>;
  skillStore: Pick<ISkillStore<unknown>, 'listSkills'>;
  spaceStore: Pick<ISpaceStore<unknown>, 'getSpace'>;
  tenant_id: string;
  /** The person in the chat; goals are made for, listed for, and checked only by them. */
  owner: CreatedBySubject;
  /** The persona this chat answers as; a goal made here belongs to it. Null when the chat has none. */
  persona_id: string | null;
  /**
   * The agent this chat runs as, used for a draft when the call names none. Resolved
   * only when a draft is made, so a turn that never makes one never settles it.
   */
  resolve_chat_agent_id: () => Promise<string | null>;
  logger: Logger;
  /** The chat this turn happens in. Null when there is no chat. */
  session_id: string | null;
}

/** What a host hands to chat turns so the goal tools can run: the goal store itself. */
export interface GoalTurnAccess {
  goalStore: IGoalStore<unknown>;
}

interface GoalToolSetOptions extends GoalTurnContext {
  tracing: AgentTracing;
  keepsNothing?: boolean | undefined;
}

const GoalStepToolSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    depends_on_indexes: z.array(z.number().int().nonnegative()).max(20).optional(),
    acceptance_criteria: z.string().trim().max(500).optional(),
    source_refs: z.array(z.string().min(1).max(512)).max(20).optional(),
  })
  .strict();

const GoalSourceToolSchema = z
  .object({
    source_kind: z.enum(['space', 'document', 'mail', 'calendar', 'web', 'manual']),
    source_ref: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(200),
  })
  .strict();

export const CreateGoalToolSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    outcome: z.string().trim().min(1).max(2000),
    success_criteria: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    target_at: z.string().nullable().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    agent_name: z.string().trim().min(1).max(200).optional(),
    selected_sources: z.array(GoalSourceToolSchema).max(50).optional(),
    steps: z.array(GoalStepToolSchema).max(50).optional(),
  })
  .strict();

export const GoalRefToolSchema = z
  .object({
    goal: z.string().trim().min(1).max(200).describe('The goal\u2019s id, or its title as the person says it.'),
  })
  .strict();

export const ListGoalsToolSchema = z
  .object({
    lifecycle: z.enum(['draft', 'active', 'paused', 'completed', 'ended']).optional(),
  })
  .strict();

type CreateGoalToolInput = z.infer<typeof CreateGoalToolSchema>;
type GoalRefToolInput = z.infer<typeof GoalRefToolSchema>;
type ListGoalsToolInput = z.infer<typeof ListGoalsToolSchema>;

function jsonResult(value: unknown) {
  return toolResultResponse({ text: JSON.stringify(value) });
}

function errorResult(message: string) {
  return toolResultResponse({ text: JSON.stringify({ error: message }), isError: true });
}

export class GoalToolSet extends LocalToolMCP {
  readonly name = GOALS_SERVER_ID;
  readonly displayName = 'Goals';
  protected override readonly bundle: ToolBundleName = 'goals';
  readonly #options: GoalToolSetOptions;
  readonly #tools: ToolDefinition[];
  readonly #service: GoalService;

  constructor(options: GoalToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#service = createGoalService({
      store: options.store,
      agentStore: options.agentStore,
      skillStore: options.skillStore,
    });
    this.#tools = [
      defineTool({
        name: CREATE_GOAL_TOOL_NAME,
        requiresNetwork: false,
        description:
          'Make a goal draft for something the person wants Aman to keep track of over time. This only makes the draft: the person reviews the activation card and activates it themselves before anything is checked or watched. Never say a goal is active unless the person activated it.',
        schema: CreateGoalToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#create(input),
      }),
      defineTool({
        name: LIST_GOALS_TOOL_NAME,
        requiresNetwork: false,
        description: "List the person's goals: title, state, target date, and what happens next on each.",
        schema: ListGoalsToolSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: input => this.#list(input),
      }),
      defineTool({
        name: GET_GOAL_TOOL_NAME,
        requiresNetwork: false,
        description:
          'Read one goal in full: its outcome, plan, what changed, the evidence behind finished steps, and the next step.',
        schema: GoalRefToolSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: input => this.#get(input),
      }),
      defineTool({
        name: REQUEST_GOAL_CHECK_TOOL_NAME,
        requiresNetwork: false,
        description:
          'Check an active goal now: read its selected sources, record what is new as evidence against its steps, and say what the next step is. A paused or draft goal cannot be checked.',
        schema: GoalRefToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#check(input),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return toolsForChat({ tools: this.#tools, keepsNothing: this.#options.keepsNothing ?? false, chatOnly: new Set() });
  }

  #actor(): GoalActor {
    return {
      tenant_id: this.#options.tenant_id,
      subject_id: this.#options.owner.subject_id,
      persona_id: this.#options.persona_id ?? undefined,
    };
  }

  /** Finds the goal a call means: by id first, then by the title the person used. */
  async #resolveGoal(ref: string): Promise<string> {
    const actor = this.#actor();
    try {
      const { goal } = await this.#service.getGoal(actor, ref);
      return goal.goal_id;
    } catch (error) {
      if (!(error instanceof GoalNotFoundError)) {
        throw error;
      }
    }
    const { data } = await this.#service.listGoals(actor, { limit: 100, page_token: undefined });
    const wanted = ref.trim().toLowerCase();
    const match = data.find(goal => goal.title.toLowerCase() === wanted);
    if (match === undefined) {
      throw new GoalNotFoundError(ref);
    }
    return match.goal_id;
  }

  #plainError(error: unknown) {
    if (error instanceof GoalNotFoundError) {
      return errorResult('No goal by that name or id belongs to this person. List the goals to see what there is.');
    }
    if (error instanceof GoalSetupChangedError) {
      return errorResult(
        'The agent setup changed since this goal was activated, so the check is held. ' +
          'Tell the person the goal needs an updated activation card, which they confirm on the Goals page.',
      );
    }
    if (error instanceof GoalStateError) {
      return errorResult(error.message);
    }
    throw error;
  }

  async #create(input: CreateGoalToolInput) {
    const actor = this.#actor();
    let agentId = await this.#options.resolve_chat_agent_id();
    if (input.agent_name !== undefined) {
      const agent = await this.#options.agentStore.getAgent({
        tenant_id: this.#options.tenant_id,
        name: input.agent_name,
      });
      if (agent === undefined) {
        return errorResult(`There is no agent named ${input.agent_name}. Name one that exists, or leave it out.`);
      }
      agentId = agent.id;
    }
    const { goal, steps } = await this.#service.createDraft(actor, {
      agent_id: agentId,
      title: input.title,
      outcome: input.outcome,
      success_criteria: input.success_criteria ?? [],
      target_at: input.target_at ?? null,
      timezone: input.timezone ?? 'UTC',
      selected_sources: input.selected_sources ?? [],
      steps: (input.steps ?? []).map(step => ({
        description: step.description,
        depends_on_indexes: step.depends_on_indexes ?? [],
        acceptance_criteria: step.acceptance_criteria ?? '',
        source_refs: step.source_refs ?? [],
      })),
    });
    return jsonResult({
      goal_id: goal.goal_id,
      title: goal.title,
      state: 'draft',
      steps: steps.map(step => step.description),
      note: 'This is a draft. The person reviews the activation card on the Goals page and activates it there before any checking starts.',
    });
  }

  async #list(input: ListGoalsToolInput) {
    const actor = this.#actor();
    const { data } = await this.#service.listGoals(actor, {
      ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
      limit: 100,
      page_token: undefined,
    });
    const summaries = await Promise.all(
      data.map(async goal => {
        const { steps } = await this.#service.getGoal(actor, goal.goal_id);
        return {
          goal_id: goal.goal_id,
          title: goal.title,
          state: goal.lifecycle,
          target_at: goal.target_at,
          next_step: nextStepOf(steps)?.description ?? null,
        };
      }),
    );
    return jsonResult({ goals: summaries });
  }

  async #get(input: GoalRefToolInput) {
    try {
      const goalId = await this.#resolveGoal(input.goal);
      const { goal, steps } = await this.#service.getGoal(this.#actor(), goalId);
      return jsonResult({
        goal_id: goal.goal_id,
        title: goal.title,
        outcome: goal.outcome,
        success_criteria: goal.success_criteria,
        target_at: goal.target_at,
        state: goal.lifecycle,
        next_check_at: goal.next_check_at,
        steps: steps.map(step => ({
          description: step.description,
          status: step.status,
          evidence_count: step.evidence_ids.length,
        })),
        next_step: nextStepOf(steps)?.description ?? null,
      });
    } catch (error) {
      return this.#plainError(error);
    }
  }

  async #check(input: GoalRefToolInput) {
    try {
      const goalId = await this.#resolveGoal(input.goal);
      const actor = this.#actor();
      const sourceReader = chainGoalSourceReaders([
        createSpaceGoalSourceReader({ spaceStore: this.#options.spaceStore }),
      ]);
      const result = await runManualCheck({
        service: this.#service,
        actor,
        goal_id: goalId,
        sourceReader,
      });
      return jsonResult({
        goal_id: result.goal.goal_id,
        title: result.goal.title,
        outcome: result.cycle.outcome,
        what_changed: result.cycle.outcome_detail,
        new_evidence: result.new_evidence.map(evidence => ({
          source: evidence.source_ref,
          excerpt: evidence.excerpt,
        })),
        unread_sources: result.unread_sources.map(source => source.label),
        next_step: result.next_step?.description ?? null,
      });
    } catch (error) {
      return this.#plainError(error);
    }
  }
}

const GOAL_INSTRUCTION_SECTION = 'goals';

const GOAL_INSTRUCTION =
  'create_goal makes a goal draft when the person asks Aman to keep track of an outcome over time. ' +
  'A draft does nothing until the person reviews its activation card and activates it, so never say a goal is being watched before then. ' +
  'list_goals and get_goal answer where things stand. request_goal_check checks an active goal now and reports what changed and what is next.';

const GOAL_READ_INSTRUCTION =
  'list_goals and get_goal show the goals the person has. This incognito chat cannot make or check a goal.';

function buildGoalInstruction(builder: InstructionBuilder): void {
  builder.addSection(GOAL_INSTRUCTION_SECTION, GOAL_INSTRUCTION);
}

function buildGoalReadInstruction(builder: InstructionBuilder): void {
  builder.addSection(GOAL_INSTRUCTION_SECTION, GOAL_READ_INSTRUCTION);
}

/** Attaches the goal tools, and the rule that a draft is not a running goal, to one chat turn's root thread. */
export function goalCapability(options: GoalToolSetOptions): AgentCapability {
  return {
    systemToolSets: [new GoalToolSet(options)],
    instructionBuilders: [options.keepsNothing === true ? buildGoalReadInstruction : buildGoalInstruction],
    bundle: 'goals',
  };
}
