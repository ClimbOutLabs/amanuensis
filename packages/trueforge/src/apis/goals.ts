/**
 * Goals API (mounted at /api/v1/goals). Handlers are thin: every rule lives in
 * the goal service, so the API and the goal tools cannot drift apart.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import type { IAgentStore } from '../db/agentStore';
import type { ISkillStore } from '../db/skillStore';
import type { ISpaceStore } from '../db/spaceStore';
import {
  activateGoalRoute,
  checkGoalRoute,
  confirmGoalStepRoute,
  createGoalRoute,
  endGoalRoute,
  getActivationPreviewRoute,
  getGoalRoute,
  listGoalApprovalsRoute,
  listGoalEventsRoute,
  listGoalEvidenceRoute,
  listGoalsRoute,
  pauseGoalRoute,
  resumeGoalRoute,
  updateGoalRoute,
} from '../routes/goalRoutes';
import { runManualCheck } from '../runtime/goals/goalCheck';
import {
  createGoalService,
  GoalNotFoundError,
  GoalSetupChangedError,
  GoalStateError,
  nextStepOf,
  type GoalActor,
  type GoalService,
} from '../runtime/goals/goalService';
import {
  GoalRevisionConflictError,
  type GoalActionRecord,
  type GoalCycleRecord,
  type GoalEventRecord,
  type GoalEvidenceRecord,
  type GoalRecord,
  type GoalStepRecord,
  type IGoalStore,
  type PinnedAgentSetup,
} from '../runtime/goals/goalStorePort';
import { chainGoalSourceReaders, createSpaceGoalSourceReader } from '../runtime/goals/spaceGoalSourceReader';
import type {
  ActivationPreview,
  Goal,
  GoalApproval,
  GoalCycle,
  GoalDetail,
  GoalEvent,
  GoalEvidence,
  GoalStep,
} from '../schemas/goal';

/** The answer a revision conflict gets: the goal moved since it was read. */
const GOAL_CHANGED_MESSAGE = 'The goal changed since it was read. Read it again, then try once more.';

export interface GoalsRouterDeps<TTransaction> {
  resolveGoalStore: (c: Context) => IGoalStore<TTransaction>;
  resolveAgentStore: (c: Context) => Pick<IAgentStore<TTransaction>, 'getAgent'>;
  resolveSkillStore: (c: Context) => Pick<ISkillStore<TTransaction>, 'listSkills'>;
  resolveSpaceStore: (c: Context) => Pick<ISpaceStore<TTransaction>, 'getSpace'>;
  resolveRequestContext: ResolveRequestContext;
}

function toWireGoal(record: GoalRecord): Goal {
  return {
    goal_id: record.goal_id,
    created_by_subject: record.created_by,
    persona_id: record.persona_id,
    title: record.title,
    outcome: record.outcome,
    success_criteria: [...record.success_criteria],
    target_at: record.target_at,
    timezone: record.timezone,
    lifecycle: record.lifecycle,
    revision: record.revision,
    agent_id: record.agent_id,
    selected_sources: record.selected_sources.map(source => ({ ...source })),
    execution_policy: { ...record.execution_policy },
    notification_policy: { ...record.notification_policy },
    linked_space_id: record.linked_space_id,
    pinned_agent_id: record.pinned_agent_id,
    pinned_agent_version: record.pinned_agent_version,
    pinned_setup:
      record.pinned_setup === null
        ? null
        : {
            agent_id: record.pinned_setup.agent_id,
            agent_name: record.pinned_setup.agent_name,
            agent_version: record.pinned_setup.agent_version,
            spec: record.pinned_setup.spec,
            skills: record.pinned_setup.skills.map(skill => ({ ...skill })),
            digest: record.pinned_setup.digest,
            pinned_at: record.pinned_setup.pinned_at,
          },
    next_check_at: record.next_check_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toWireStep(record: GoalStepRecord): GoalStep {
  return {
    step_id: record.step_id,
    goal_id: record.goal_id,
    description: record.description,
    depends_on: [...record.depends_on],
    status: record.status,
    acceptance_criteria: record.acceptance_criteria,
    source_refs: [...record.source_refs],
    evidence_ids: [...record.evidence_ids],
    action_id: record.action_id,
  };
}

function toWireDetail(input: { goal: GoalRecord; steps: GoalStepRecord[] }): GoalDetail {
  return {
    goal: toWireGoal(input.goal),
    steps: input.steps.map(toWireStep),
    next_step_id: nextStepOf(input.steps)?.step_id ?? null,
  };
}

function toWirePreview(input: {
  goal: GoalRecord;
  steps: GoalStepRecord[];
  setup: PinnedAgentSetup;
}): ActivationPreview {
  return {
    goal: toWireGoal(input.goal),
    steps: input.steps.map(toWireStep),
    setup: {
      agent_id: input.setup.agent_id,
      agent_name: input.setup.agent_name,
      agent_version: input.setup.agent_version,
      spec: input.setup.spec,
      skills: input.setup.skills.map(skill => ({ ...skill })),
      digest: input.setup.digest,
      pinned_at: input.setup.pinned_at,
    },
  };
}

function toWireEvidence(record: GoalEvidenceRecord): GoalEvidence {
  return { ...record };
}

function toWireEvent(record: GoalEventRecord): GoalEvent {
  return { ...record };
}

function toWireApproval(record: GoalActionRecord): GoalApproval {
  return { ...record };
}

function toWireCycle(record: GoalCycleRecord): GoalCycle {
  return { ...record };
}

export function createGoalsRouter<TTransaction>(deps: GoalsRouterDeps<TTransaction>) {
  function serviceFor(c: Context): GoalService {
    return createGoalService({
      store: deps.resolveGoalStore(c),
      agentStore: deps.resolveAgentStore(c),
      skillStore: deps.resolveSkillStore(c),
    });
  }

  function actorFor(c: Context): GoalActor {
    const requestContext = deps.resolveRequestContext(c);
    return { tenant_id: requestContext.tenant_id, subject_id: requestContext.subject.id };
  }

  /**
   * The updated card a refused activate or check is answered with, resolved
   * fresh at response time. Those two routes declare one 409 shape, the card,
   * so a revision conflict there is answered with the card too: the goal moved
   * since it was read, which is the refusal the card exists for. When the fresh
   * card cannot be resolved, the reason it failed is the answer instead.
   */
  async function answerWithUpdatedCard(c: Context, actor: GoalActor, input: { goal_id: string; message: string }) {
    try {
      const preview = await serviceFor(c).previewActivation(actor, input.goal_id);
      return c.json(
        {
          error: { message: input.message, code: 'goal_setup_changed' as const },
          data: toWirePreview(preview),
        },
        409,
      );
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  }

  const listHandler: RouteHandler<typeof listGoalsRoute> = async c => {
    const { limit, page_token: pageToken, lifecycle } = c.req.valid('query');
    const actor = actorFor(c);
    const { data, pagination } = await serviceFor(c).listGoals(actor, {
      ...(lifecycle === undefined ? {} : { lifecycle }),
      limit,
      page_token: pageToken,
    });
    return c.json({ data: data.map(toWireGoal), pagination }, 200);
  };

  const createHandler: RouteHandler<typeof createGoalRoute> = async c => {
    const body = c.req.valid('json');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).createDraft(actor, {
        agent_id: body.agent_id,
        title: body.title,
        outcome: body.outcome,
        success_criteria: body.success_criteria,
        target_at: body.target_at,
        timezone: body.timezone,
        selected_sources: body.selected_sources,
        steps: body.steps.map(step => ({
          description: step.description,
          depends_on_indexes: step.depends_on_indexes,
          acceptance_criteria: step.acceptance_criteria,
          source_refs: step.source_refs,
        })),
        ...(body.execution_policy === undefined ? {} : { execution_policy: body.execution_policy }),
        ...(body.notification_policy === undefined ? {} : { notification_policy: body.notification_policy }),
        linked_space_id: body.linked_space_id,
      });
      return c.json({ data: toWireDetail(result) }, 201);
    } catch (error) {
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).getGoal(actor, goalId);
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const updateHandler: RouteHandler<typeof updateGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const body = c.req.valid('json');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).updateGoal(actor, goalId, {
        expected_revision: body.expected_revision,
        patch: {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
          ...(body.success_criteria === undefined ? {} : { success_criteria: body.success_criteria }),
          ...(body.target_at === undefined ? {} : { target_at: body.target_at }),
          ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
          ...(body.agent_id === undefined ? {} : { agent_id: body.agent_id }),
          ...(body.selected_sources === undefined ? {} : { selected_sources: body.selected_sources }),
          ...(body.execution_policy === undefined ? {} : { execution_policy: body.execution_policy }),
          ...(body.notification_policy === undefined ? {} : { notification_policy: body.notification_policy }),
          ...(body.linked_space_id === undefined ? {} : { linked_space_id: body.linked_space_id }),
        },
      });
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalRevisionConflictError) {
        return c.json({ error: { message: GOAL_CHANGED_MESSAGE } }, 409);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const previewHandler: RouteHandler<typeof getActivationPreviewRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).previewActivation(actor, goalId);
      return c.json({ data: toWirePreview(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const activateHandler: RouteHandler<typeof activateGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const body = c.req.valid('json');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).activate(actor, goalId, {
        expected_revision: body.expected_revision,
        setup_digest: body.setup_digest,
      });
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalSetupChangedError) {
        return answerWithUpdatedCard(c, actor, { goal_id: goalId, message: error.message });
      }
      if (error instanceof GoalRevisionConflictError) {
        return answerWithUpdatedCard(c, actor, { goal_id: goalId, message: GOAL_CHANGED_MESSAGE });
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const pauseHandler: RouteHandler<typeof pauseGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const body = c.req.valid('json');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).pause(actor, goalId, { expected_revision: body.expected_revision });
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalRevisionConflictError) {
        return c.json({ error: { message: GOAL_CHANGED_MESSAGE } }, 409);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const resumeHandler: RouteHandler<typeof resumeGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const body = c.req.valid('json');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).resume(actor, goalId, { expected_revision: body.expected_revision });
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalRevisionConflictError) {
        return c.json({ error: { message: GOAL_CHANGED_MESSAGE } }, 409);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const endHandler: RouteHandler<typeof endGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const body = c.req.valid('json');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).end(actor, goalId, { expected_revision: body.expected_revision });
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalRevisionConflictError) {
        return c.json({ error: { message: GOAL_CHANGED_MESSAGE } }, 409);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const checkHandler: RouteHandler<typeof checkGoalRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const actor = actorFor(c);
    const service = serviceFor(c);
    const sourceReader = chainGoalSourceReaders([
      createSpaceGoalSourceReader({ spaceStore: deps.resolveSpaceStore(c) }),
    ]);
    try {
      const result = await runManualCheck({
        service,
        actor,
        goal_id: goalId,
        sourceReader,
      });
      return c.json(
        {
          data: {
            cycle: toWireCycle(result.cycle),
            goal: toWireGoal(result.goal),
            steps: result.steps.map(toWireStep),
            new_evidence: result.new_evidence.map(toWireEvidence),
            unread_sources: result.unread_sources.map(source => ({ ...source })),
            next_step_id: result.next_step?.step_id ?? null,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalSetupChangedError) {
        return answerWithUpdatedCard(c, actor, { goal_id: goalId, message: error.message });
      }
      if (error instanceof GoalRevisionConflictError) {
        return answerWithUpdatedCard(c, actor, { goal_id: goalId, message: GOAL_CHANGED_MESSAGE });
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const confirmStepHandler: RouteHandler<typeof confirmGoalStepRoute> = async c => {
    const { goal_id: goalId, step_id: stepId } = c.req.valid('param');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).confirmStep(actor, goalId, stepId);
      return c.json({ data: toWireDetail(result) }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof GoalRevisionConflictError) {
        return c.json({ error: { message: GOAL_CHANGED_MESSAGE } }, 409);
      }
      if (error instanceof GoalStateError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const evidenceHandler: RouteHandler<typeof listGoalEvidenceRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const { limit, page_token: pageToken } = c.req.valid('query');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).listEvidence(actor, goalId, { limit, page_token: pageToken });
      return c.json({ data: result.data.map(toWireEvidence), pagination: result.pagination }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const eventsHandler: RouteHandler<typeof listGoalEventsRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const { limit, page_token: pageToken } = c.req.valid('query');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).listEvents(actor, goalId, { limit, page_token: pageToken });
      return c.json({ data: result.data.map(toWireEvent), pagination: result.pagination }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const approvalsHandler: RouteHandler<typeof listGoalApprovalsRoute> = async c => {
    const { goal_id: goalId } = c.req.valid('param');
    const { limit, page_token: pageToken } = c.req.valid('query');
    const actor = actorFor(c);
    try {
      const result = await serviceFor(c).listWaitingApprovals(actor, goalId, { limit, page_token: pageToken });
      return c.json({ data: result.data.map(toWireApproval), pagination: result.pagination }, 200);
    } catch (error) {
      if (error instanceof GoalNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(listGoalsRoute, listHandler);
  router.openapi(createGoalRoute, createHandler);
  router.openapi(getGoalRoute, getHandler);
  router.openapi(updateGoalRoute, updateHandler);
  router.openapi(getActivationPreviewRoute, previewHandler);
  router.openapi(activateGoalRoute, activateHandler);
  router.openapi(pauseGoalRoute, pauseHandler);
  router.openapi(resumeGoalRoute, resumeHandler);
  router.openapi(endGoalRoute, endHandler);
  router.openapi(checkGoalRoute, checkHandler);
  router.openapi(confirmGoalStepRoute, confirmStepHandler);
  router.openapi(listGoalEvidenceRoute, evidenceHandler);
  router.openapi(listGoalEventsRoute, eventsHandler);
  router.openapi(listGoalApprovalsRoute, approvalsHandler);
  return router;
}
