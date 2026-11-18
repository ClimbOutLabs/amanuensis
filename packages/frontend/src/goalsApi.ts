import type { TrueForge } from '@truefoundry/trueforge-sdk';
import {
  GoalSetupChangedError,
  type CreateGoalInput,
  type GoalActivationPreview,
  type GoalApproval,
  type GoalCheckResult,
  type GoalCycle,
  type GoalCycleOutcome,
  type GoalDetail,
  type GoalEvent,
  type GoalEvidence,
  type GoalExecutionPolicy,
  type GoalItem,
  type GoalLifecycle,
  type GoalNotificationPolicy,
  type GoalSetupSummary,
  type GoalSourceKind,
  type GoalSourceRef,
  type GoalStep,
  type GoalStepStatus,
  type GoalsApi,
  type UpdateGoalInput,
} from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

// The server owns the wire shape (packages/trueforge/src/schemas/goal.ts). Bodies are checked here, never
// asserted: a row this version does not recognise is dropped from lists, and a single read that does not
// parse is an error rather than a wrong drawing.
const GOALS_URL = '/api/v1/goals';
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const LIFECYCLES: readonly GoalLifecycle[] = ['draft', 'active', 'paused', 'completed', 'ended'];
const STEP_STATUSES: readonly GoalStepStatus[] = [
  'planned',
  'ready',
  'in_progress',
  'waiting_for_approval',
  'awaiting_verification',
  'verified',
  'owner_confirmed',
  'failed',
  'outcome_unknown',
];
const SOURCE_KINDS: readonly GoalSourceKind[] = ['space', 'document', 'mail', 'calendar', 'web', 'manual'];
const CYCLE_OUTCOMES: readonly GoalCycleOutcome[] = [
  'completed',
  'nothing_changed',
  'needs_decision',
  'budget_exhausted',
  'failed',
];

function isGoalLifecycle(value: string): value is GoalLifecycle {
  return LIFECYCLES.some(entry => entry === value);
}

function isGoalStepStatus(value: string): value is GoalStepStatus {
  return STEP_STATUSES.some(entry => entry === value);
}

function isGoalSourceKind(value: string): value is GoalSourceKind {
  return SOURCE_KINDS.some(entry => entry === value);
}

function isGoalCycleOutcome(value: string): value is GoalCycleOutcome {
  return CYCLE_OUTCOMES.some(entry => entry === value);
}

function parseSourceRef(value: unknown): GoalSourceRef | null {
  if (!isRecord(value)) return null;
  const { source_kind: sourceKind, source_ref: sourceRef, label } = value;
  if (
    typeof sourceKind !== 'string' ||
    !isGoalSourceKind(sourceKind) ||
    typeof sourceRef !== 'string' ||
    typeof label !== 'string'
  ) {
    return null;
  }
  return { sourceKind, sourceRef, label };
}

function parseSourceRefs(value: unknown): GoalSourceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.map(parseSourceRef);
  return refs.every(ref => ref !== null) ? refs : null;
}

function parseExecutionPolicy(value: unknown): GoalExecutionPolicy | null {
  if (!isRecord(value)) return null;
  const {
    checks_per_day: checksPerDay,
    cycle_minutes: cycleMinutes,
    model_call_limit: modelCallLimit,
    tool_call_limit: toolCallLimit,
    cycle_token_limit: cycleTokenLimit,
    daily_token_allowance: dailyTokenAllowance,
  } = value;
  if (
    !isFiniteNumber(checksPerDay) ||
    !isFiniteNumber(cycleMinutes) ||
    !isFiniteNumber(modelCallLimit) ||
    !isFiniteNumber(toolCallLimit) ||
    !isFiniteNumber(cycleTokenLimit) ||
    !isFiniteNumber(dailyTokenAllowance)
  ) {
    return null;
  }
  return { checksPerDay, cycleMinutes, modelCallLimit, toolCallLimit, cycleTokenLimit, dailyTokenAllowance };
}

function parseNotificationPolicy(value: unknown): GoalNotificationPolicy | null {
  if (!isRecord(value) || typeof value.digest !== 'boolean') return null;
  return { digest: value.digest };
}

/** The pinned setup as the card shows it: names and the model, never the full spec or any credential. */
function parseSetupSummary(value: unknown): GoalSetupSummary | null {
  if (!isRecord(value)) return null;
  const {
    agent_id: agentId,
    agent_name: agentName,
    agent_version: agentVersion,
    spec,
    skills,
    digest,
    pinned_at: pinnedAt,
  } = value;
  if (
    typeof agentId !== 'string' ||
    typeof agentName !== 'string' ||
    !isNullableString(agentVersion) ||
    !isRecord(spec) ||
    !Array.isArray(skills) ||
    typeof digest !== 'string' ||
    typeof pinnedAt !== 'string'
  ) {
    return null;
  }
  const model = isRecord(spec.model) ? spec.model : null;
  const modelName = model !== null && typeof model.name === 'string' ? model.name : null;
  if (modelName === null) return null;
  const servers = Array.isArray(spec.mcp_servers) ? spec.mcp_servers : [];
  const mcpServerNames = servers
    .map(server => (isRecord(server) && typeof server.name === 'string' ? server.name : null))
    .filter((name): name is string => name !== null);
  const skillNames = skills
    .map(skill => (isRecord(skill) && typeof skill.name === 'string' ? skill.name : null))
    .filter((name): name is string => name !== null);
  return { agentId, agentName, agentVersion, modelName, mcpServerNames, skillNames, digest, pinnedAt };
}

function parseGoal(value: unknown): GoalItem | null {
  if (!isRecord(value)) return null;
  const {
    goal_id: goalId,
    title,
    outcome,
    success_criteria: successCriteria,
    target_at: targetAt,
    timezone,
    lifecycle,
    revision,
    agent_id: agentId,
    selected_sources: selectedSourcesRaw,
    execution_policy: executionPolicyRaw,
    notification_policy: notificationPolicyRaw,
    linked_space_id: linkedSpaceId,
    pinned_setup: pinnedSetupRaw,
    next_check_at: nextCheckAt,
    created_at: createdAt,
    updated_at: updatedAt,
  } = value;
  const selectedSources = parseSourceRefs(selectedSourcesRaw);
  const executionPolicy = parseExecutionPolicy(executionPolicyRaw);
  const notificationPolicy = parseNotificationPolicy(notificationPolicyRaw);
  const pinnedSetup = pinnedSetupRaw === null ? null : parseSetupSummary(pinnedSetupRaw);
  if (
    typeof goalId !== 'string' ||
    typeof title !== 'string' ||
    typeof outcome !== 'string' ||
    !isStringArray(successCriteria) ||
    !isNullableString(targetAt) ||
    typeof timezone !== 'string' ||
    typeof lifecycle !== 'string' ||
    !isGoalLifecycle(lifecycle) ||
    !isFiniteNumber(revision) ||
    !isNullableString(agentId) ||
    selectedSources === null ||
    executionPolicy === null ||
    notificationPolicy === null ||
    !isNullableString(linkedSpaceId) ||
    (pinnedSetupRaw !== null && pinnedSetup === null) ||
    !isNullableString(nextCheckAt) ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    goalId,
    title,
    outcome,
    successCriteria,
    targetAt,
    timezone,
    lifecycle,
    revision,
    agentId,
    selectedSources,
    executionPolicy,
    notificationPolicy,
    linkedSpaceId,
    pinnedSetup,
    nextCheckAt,
    createdAt,
    updatedAt,
  };
}

function parseStep(value: unknown): GoalStep | null {
  if (!isRecord(value)) return null;
  const {
    step_id: stepId,
    goal_id: goalId,
    description,
    depends_on: dependsOn,
    status,
    acceptance_criteria: acceptanceCriteria,
    source_refs: sourceRefs,
    evidence_ids: evidenceIds,
    action_id: actionId,
  } = value;
  if (
    typeof stepId !== 'string' ||
    typeof goalId !== 'string' ||
    typeof description !== 'string' ||
    !isStringArray(dependsOn) ||
    typeof status !== 'string' ||
    !isGoalStepStatus(status) ||
    typeof acceptanceCriteria !== 'string' ||
    !isStringArray(sourceRefs) ||
    !isStringArray(evidenceIds) ||
    !isNullableString(actionId)
  ) {
    return null;
  }
  return {
    stepId,
    goalId,
    description,
    dependsOn,
    status,
    acceptanceCriteria,
    sourceRefs,
    evidenceIds,
    actionId,
  };
}

function parseSteps(value: unknown): GoalStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value.map(parseStep);
  return steps.every(step => step !== null) ? steps : null;
}

function parseDetail(value: unknown): GoalDetail | null {
  if (!isRecord(value)) return null;
  const goal = parseGoal(value.goal);
  const steps = parseSteps(value.steps);
  const nextStepId = value.next_step_id;
  if (goal === null || steps === null || !isNullableString(nextStepId)) return null;
  return { goal, steps, nextStepId };
}

function parsePreview(value: unknown): GoalActivationPreview | null {
  if (!isRecord(value)) return null;
  const goal = parseGoal(value.goal);
  const steps = parseSteps(value.steps);
  const setup = parseSetupSummary(value.setup);
  if (goal === null || steps === null || setup === null) return null;
  return { goal, steps, setup };
}

function parseEvidence(value: unknown): GoalEvidence | null {
  if (!isRecord(value)) return null;
  const {
    evidence_id: evidenceId,
    goal_id: goalId,
    cycle_id: cycleId,
    source_kind: sourceKind,
    source_ref: sourceRef,
    source_revision: sourceRevision,
    observed_at: observedAt,
    claimed_event_at: claimedEventAt,
    freshness,
    admission,
    extraction_method: extractionMethod,
    excerpt,
  } = value;
  if (
    typeof evidenceId !== 'string' ||
    typeof goalId !== 'string' ||
    !isNullableString(cycleId) ||
    typeof sourceKind !== 'string' ||
    !isGoalSourceKind(sourceKind) ||
    typeof sourceRef !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof observedAt !== 'string' ||
    !isNullableString(claimedEventAt) ||
    typeof freshness !== 'string' ||
    typeof admission !== 'string' ||
    typeof extractionMethod !== 'string' ||
    typeof excerpt !== 'string'
  ) {
    return null;
  }
  return {
    evidenceId,
    goalId,
    cycleId,
    sourceKind,
    sourceRef,
    sourceRevision,
    observedAt,
    claimedEventAt,
    freshness,
    admission,
    extractionMethod,
    excerpt,
  };
}

function parseEvent(value: unknown): GoalEvent | null {
  if (!isRecord(value)) return null;
  const {
    event_id: eventId,
    goal_id: goalId,
    sequence,
    event_type: eventType,
    actor,
    payload,
    created_at: createdAt,
  } = value;
  if (
    typeof eventId !== 'string' ||
    typeof goalId !== 'string' ||
    !isFiniteNumber(sequence) ||
    typeof eventType !== 'string' ||
    typeof actor !== 'string' ||
    !isRecord(payload) ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  return { eventId, goalId, sequence, eventType, actor, payload, createdAt };
}

function parseApproval(value: unknown): GoalApproval | null {
  if (!isRecord(value)) return null;
  const {
    action_id: actionId,
    goal_id: goalId,
    cycle_id: cycleId,
    expected_revision: expectedRevision,
    tool_call_ref: toolCallRef,
    approval_ref: approvalRef,
    execution_state: executionState,
    receipt_ref: receiptRef,
    created_at: createdAt,
  } = value;
  if (
    typeof actionId !== 'string' ||
    typeof goalId !== 'string' ||
    !isNullableString(cycleId) ||
    !isFiniteNumber(expectedRevision) ||
    !isNullableString(toolCallRef) ||
    !isNullableString(approvalRef) ||
    typeof executionState !== 'string' ||
    !isNullableString(receiptRef) ||
    typeof createdAt !== 'string'
  ) {
    return null;
  }
  return {
    actionId,
    goalId,
    cycleId,
    expectedRevision,
    toolCallRef,
    approvalRef,
    executionState,
    receiptRef,
    createdAt,
  };
}

function parseCycle(value: unknown): GoalCycle | null {
  if (!isRecord(value)) return null;
  const {
    cycle_id: cycleId,
    goal_id: goalId,
    input_revision: inputRevision,
    trigger,
    started_at: startedAt,
    finished_at: finishedAt,
    outcome,
    outcome_detail: outcomeDetail,
    session_id: sessionId,
    next_check_at: nextCheckAt,
  } = value;
  let parsedOutcome: GoalCycleOutcome | null = null;
  let outcomeValid = outcome === null;
  if (typeof outcome === 'string' && isGoalCycleOutcome(outcome)) {
    parsedOutcome = outcome;
    outcomeValid = true;
  }
  if (
    typeof cycleId !== 'string' ||
    typeof goalId !== 'string' ||
    !isFiniteNumber(inputRevision) ||
    typeof trigger !== 'string' ||
    typeof startedAt !== 'string' ||
    !isNullableString(finishedAt) ||
    !outcomeValid ||
    !isNullableString(outcomeDetail) ||
    !isNullableString(sessionId) ||
    !isNullableString(nextCheckAt)
  ) {
    return null;
  }
  return {
    cycleId,
    goalId,
    inputRevision,
    trigger,
    startedAt,
    finishedAt,
    outcome: parsedOutcome,
    outcomeDetail,
    sessionId,
    nextCheckAt,
  };
}

function parseCheckResult(value: unknown): GoalCheckResult | null {
  if (!isRecord(value)) return null;
  const cycle = parseCycle(value.cycle);
  const goal = parseGoal(value.goal);
  const steps = parseSteps(value.steps);
  const newEvidence = Array.isArray(value.new_evidence) ? value.new_evidence.map(parseEvidence) : null;
  const unreadSources = parseSourceRefs(value.unread_sources);
  const nextStepId = value.next_step_id;
  if (
    cycle === null ||
    goal === null ||
    steps === null ||
    newEvidence === null ||
    newEvidence.some(entry => entry === null) ||
    unreadSources === null ||
    !isNullableString(nextStepId)
  ) {
    return null;
  }
  return {
    cycle,
    goal,
    steps,
    newEvidence: newEvidence.filter((entry): entry is GoalEvidence => entry !== null),
    unreadSources,
    nextStepId,
  };
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '') {
    return body.error.message;
  }
  return `That did not work (error ${String(status)}). Try again in a moment.`;
}

function sourceRefBody(source: GoalSourceRef): Record<string, unknown> {
  return { source_kind: source.sourceKind, source_ref: source.sourceRef, label: source.label };
}

function executionPolicyBody(policy: GoalExecutionPolicy): Record<string, unknown> {
  return {
    checks_per_day: policy.checksPerDay,
    cycle_minutes: policy.cycleMinutes,
    model_call_limit: policy.modelCallLimit,
    tool_call_limit: policy.toolCallLimit,
    cycle_token_limit: policy.cycleTokenLimit,
    daily_token_allowance: policy.dailyTokenAllowance,
  };
}

/** Backs `GoalsProvider`: the goals API over the signed-in fetch, plus the saved agents for the create form. */
export function createGoalsApi({ fetcher, client }: { fetcher: typeof fetch; client: TrueForge }): GoalsApi {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetcher(apiPath(path), init);
    const body: unknown = await response.json().catch((): null => null);
    if (!response.ok) {
      if (
        response.status === 409 &&
        isRecord(body) &&
        isRecord(body.error) &&
        body.error.code === 'goal_setup_changed'
      ) {
        const preview = parsePreview(body.data);
        if (preview !== null) {
          throw new GoalSetupChangedError(errorMessage({ body, status: response.status }), preview);
        }
      }
      throw new Error(errorMessage({ body, status: response.status }));
    }
    return body;
  }

  function dataOf(body: unknown): unknown {
    return isRecord(body) ? body.data : undefined;
  }

  async function listAll<T>(path: string, parse: (value: unknown) => T | null): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (pageToken !== undefined) query.set('page_token', pageToken);
      const body = await request(`${path}?${query.toString()}`);
      const rows: unknown = dataOf(body);
      if (Array.isArray(rows)) {
        items.push(...rows.map(parse).filter((item): item is T => item !== null));
      }
      const pagination = isRecord(body) ? body.pagination : undefined;
      const next: unknown = isRecord(pagination) ? pagination.next_page_token : undefined;
      if (typeof next !== 'string' || next === '') break;
      pageToken = next;
    }
    return items;
  }

  async function readDetail(goalId: string): Promise<GoalDetail> {
    const body = await request(`${GOALS_URL}/${encodeURIComponent(goalId)}`);
    const detail = parseDetail(dataOf(body));
    if (detail === null) throw new Error('That goal came back in a shape this version does not recognise.');
    return detail;
  }

  async function mutate(path: string, payload: Record<string, unknown>): Promise<GoalDetail> {
    const body = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const detail = parseDetail(dataOf(body));
    if (detail === null) throw new Error('That goal came back in a shape this version does not recognise.');
    return detail;
  }

  return {
    listGoals() {
      return listAll(GOALS_URL, parseGoal);
    },
    getGoal: readDetail,
    async createGoal(input: CreateGoalInput) {
      const body = await request(GOALS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent_id: input.agentId,
          title: input.title,
          outcome: input.outcome,
          success_criteria: input.successCriteria,
          target_at: input.targetAt,
          timezone: input.timezone,
          selected_sources: input.selectedSources.map(sourceRefBody),
          steps: input.steps.map(step => ({
            description: step.description,
            depends_on_indexes: step.dependsOnIndexes,
            acceptance_criteria: step.acceptanceCriteria,
            source_refs: step.sourceRefs,
          })),
          ...(input.executionPolicy === undefined
            ? {}
            : { execution_policy: executionPolicyBody(input.executionPolicy) }),
          ...(input.notificationPolicy === undefined
            ? {}
            : { notification_policy: { digest: input.notificationPolicy.digest } }),
          linked_space_id: input.linkedSpaceId ?? null,
        }),
      });
      const detail = parseDetail(dataOf(body));
      if (detail === null) throw new Error('That goal came back in a shape this version does not recognise.');
      return detail;
    },
    async updateGoal(goalId: string, input: UpdateGoalInput) {
      const payload: Record<string, unknown> = { expected_revision: input.expectedRevision };
      if (input.title !== undefined) payload.title = input.title;
      if (input.outcome !== undefined) payload.outcome = input.outcome;
      if (input.successCriteria !== undefined) payload.success_criteria = input.successCriteria;
      if (input.targetAt !== undefined) payload.target_at = input.targetAt;
      if (input.timezone !== undefined) payload.timezone = input.timezone;
      if (input.selectedSources !== undefined) payload.selected_sources = input.selectedSources.map(sourceRefBody);
      if (input.executionPolicy !== undefined) payload.execution_policy = executionPolicyBody(input.executionPolicy);
      if (input.notificationPolicy !== undefined)
        payload.notification_policy = { digest: input.notificationPolicy.digest };
      if (input.linkedSpaceId !== undefined) payload.linked_space_id = input.linkedSpaceId;
      const body = await request(`${GOALS_URL}/${encodeURIComponent(goalId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const detail = parseDetail(dataOf(body));
      if (detail === null) throw new Error('That goal came back in a shape this version does not recognise.');
      return detail;
    },
    async getActivationPreview(goalId: string) {
      const body = await request(`${GOALS_URL}/${encodeURIComponent(goalId)}/activation-preview`);
      const preview = parsePreview(dataOf(body));
      if (preview === null)
        throw new Error('The activation card came back in a shape this version does not recognise.');
      return preview;
    },
    activateGoal(goalId, input) {
      return mutate(`${GOALS_URL}/${encodeURIComponent(goalId)}/activate`, {
        expected_revision: input.expectedRevision,
        setup_digest: input.setupDigest,
      });
    },
    pauseGoal(goalId, expectedRevision) {
      return mutate(`${GOALS_URL}/${encodeURIComponent(goalId)}/pause`, { expected_revision: expectedRevision });
    },
    resumeGoal(goalId, expectedRevision) {
      return mutate(`${GOALS_URL}/${encodeURIComponent(goalId)}/resume`, { expected_revision: expectedRevision });
    },
    endGoal(goalId, expectedRevision) {
      return mutate(`${GOALS_URL}/${encodeURIComponent(goalId)}/end`, { expected_revision: expectedRevision });
    },
    async checkGoal(goalId: string) {
      const body = await request(`${GOALS_URL}/${encodeURIComponent(goalId)}/check`, { method: 'POST' });
      const result = parseCheckResult(dataOf(body));
      if (result === null) throw new Error('That check came back in a shape this version does not recognise.');
      return result;
    },
    listEvidence(goalId) {
      return listAll(`${GOALS_URL}/${encodeURIComponent(goalId)}/evidence`, parseEvidence);
    },
    listEvents(goalId) {
      return listAll(`${GOALS_URL}/${encodeURIComponent(goalId)}/events`, parseEvent);
    },
    listApprovals(goalId) {
      return listAll(`${GOALS_URL}/${encodeURIComponent(goalId)}/approvals`, parseApproval);
    },
    async listAgents() {
      const agents: { id: string; name: string }[] = [];
      const page = await client.agents.list({ limit: 50 });
      for (;;) {
        for (const agent of page.data) {
          agents.push({ id: agent.id, name: agent.name });
        }
        if (!page.hasNextPage()) break;
        await page.getNextPage();
      }
      return agents;
    },
  };
}
