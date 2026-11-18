import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GoalSetupChangedError } from '@truefoundry/trueforge-ui';

import { createGoalsApi } from '../src/goalsApi';

const POLICY_WIRE = {
  checks_per_day: 1,
  cycle_minutes: 15,
  model_call_limit: 12,
  tool_call_limit: 40,
  cycle_token_limit: 300_000,
  daily_token_allowance: 1_000_000,
};

const SETUP_WIRE = {
  agent_id: 'agent-1',
  agent_name: 'Fundraiser helper',
  agent_version: 'v3',
  spec: { model: { name: 'test/fundraiser-model' }, mcp_servers: [{ name: 'files' }], skills: [] },
  skills: [{ name: 'planning', preload: true, digest: 'skill-digest' }],
  digest: 'digest-1',
  pinned_at: '2026-06-10T16:00:00.000Z',
};

function goalWire(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    goal_id: 'goal-1',
    created_by_subject: 'owner-1',
    persona_id: null,
    title: 'Community fundraiser',
    outcome: 'Hold a community fundraiser with the venue and equipment confirmed',
    success_criteria: ['Venue confirmed in writing'],
    target_at: '2026-06-20T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
    lifecycle: 'draft',
    revision: 1,
    agent_id: 'agent-1',
    selected_sources: [{ source_kind: 'document', source_ref: 'venue-booking-letter', label: 'Venue booking letter' }],
    execution_policy: POLICY_WIRE,
    notification_policy: { digest: true },
    linked_space_id: null,
    pinned_agent_id: null,
    pinned_agent_version: null,
    pinned_setup: null,
    next_check_at: null,
    created_at: '2026-06-10T16:00:00.000Z',
    updated_at: '2026-06-10T16:00:00.000Z',
    ...overrides,
  };
}

const STEPS_WIRE = [
  {
    step_id: 'step-venue',
    goal_id: 'goal-1',
    description: 'Confirm the venue',
    depends_on: [],
    status: 'planned',
    acceptance_criteria: 'The venue confirms in writing',
    source_refs: ['venue-booking-letter'],
    evidence_ids: [],
    action_id: null,
  },
  {
    step_id: 'step-equipment',
    goal_id: 'goal-1',
    description: 'Book the equipment',
    depends_on: ['step-venue'],
    status: 'planned',
    acceptance_criteria: '',
    source_refs: [],
    evidence_ids: [],
    action_id: null,
  },
];

function detailWire(goalOverrides: Record<string, unknown>): Record<string, unknown> {
  return { goal: goalWire(goalOverrides), steps: STEPS_WIRE, next_step_id: null };
}

const unusedClient = {
  agents: {
    list: () => Promise.reject(new Error('not used in this test')),
  },
};

test('goals API lists goals page by page and parses the wire shape', async () => {
  const urls: string[] = [];
  const api = createGoalsApi({
    fetcher: async input => {
      const url = String(input);
      urls.push(url);
      if (url.includes('page_token=tok2')) {
        return Response.json({
          data: [goalWire({ goal_id: 'goal-2', title: 'Second goal' })],
          pagination: { limit: 100 },
        });
      }
      return Response.json({
        data: [goalWire({})],
        pagination: { next_page_token: 'tok2', limit: 100 },
      });
    },
    client: unusedClient,
  });

  const goals = await api.listGoals();
  assert.equal(goals.length, 2);
  assert.equal(goals[0]?.title, 'Community fundraiser');
  assert.equal(goals[0]?.lifecycle, 'draft');
  assert.equal(goals[0]?.selectedSources[0]?.label, 'Venue booking letter');
  assert.equal(goals[0]?.executionPolicy.dailyTokenAllowance, 1_000_000);
  assert.equal(goals[1]?.goalId, 'goal-2');
  assert.equal(urls.length, 2);
  assert.ok(urls[1]?.includes('page_token=tok2'));
});

test('goals API drops a list row it does not recognise and keeps the rest', async () => {
  const api = createGoalsApi({
    fetcher: async () => Response.json({ data: [goalWire({}), { goal_id: 42 }], pagination: { limit: 100 } }),
    client: unusedClient,
  });
  const goals = await api.listGoals();
  assert.equal(goals.length, 1);
});

test('goals API creates a draft with snake case steps and dependency indexes', async () => {
  let sentBody: unknown = null;
  const api = createGoalsApi({
    fetcher: async (_input, init) => {
      sentBody = init?.body !== undefined ? JSON.parse(String(init.body)) : null;
      return Response.json({ data: detailWire({}) }, { status: 201 });
    },
    client: unusedClient,
  });

  const detail = await api.createGoal({
    agentId: 'agent-1',
    title: 'Community fundraiser',
    outcome: 'Hold a community fundraiser with the venue and equipment confirmed',
    successCriteria: ['Venue confirmed in writing'],
    targetAt: null,
    timezone: 'America/Los_Angeles',
    selectedSources: [{ sourceKind: 'document', sourceRef: 'venue-booking-letter', label: 'Venue booking letter' }],
    steps: [
      {
        description: 'Confirm the venue',
        dependsOnIndexes: [],
        acceptanceCriteria: 'The venue confirms in writing',
        sourceRefs: ['venue-booking-letter'],
      },
      { description: 'Book the equipment', dependsOnIndexes: [0], acceptanceCriteria: '', sourceRefs: [] },
    ],
  });

  assert.equal(detail.goal.goalId, 'goal-1');
  assert.equal(detail.steps[1]?.dependsOn[0], 'step-venue');
  assert.deepEqual(sentBody, {
    agent_id: 'agent-1',
    title: 'Community fundraiser',
    outcome: 'Hold a community fundraiser with the venue and equipment confirmed',
    success_criteria: ['Venue confirmed in writing'],
    target_at: null,
    timezone: 'America/Los_Angeles',
    selected_sources: [{ source_kind: 'document', source_ref: 'venue-booking-letter', label: 'Venue booking letter' }],
    steps: [
      {
        description: 'Confirm the venue',
        depends_on_indexes: [],
        acceptance_criteria: 'The venue confirms in writing',
        source_refs: ['venue-booking-letter'],
      },
      { description: 'Book the equipment', depends_on_indexes: [0], acceptance_criteria: '', source_refs: [] },
    ],
    linked_space_id: null,
  });
});

test('goals API sends the revision and digest on activate, and maps a changed setup to its error', async () => {
  let sentBody: unknown = null;
  const okApi = createGoalsApi({
    fetcher: async (_input, init) => {
      sentBody = init?.body !== undefined ? JSON.parse(String(init.body)) : null;
      return Response.json({ data: detailWire({ lifecycle: 'active', revision: 2, pinned_setup: SETUP_WIRE }) });
    },
    client: unusedClient,
  });
  const detail = await okApi.activateGoal('goal-1', { expectedRevision: 1, setupDigest: 'digest-1' });
  assert.deepEqual(sentBody, { expected_revision: 1, setup_digest: 'digest-1' });
  assert.equal(detail.goal.lifecycle, 'active');
  assert.equal(detail.goal.pinnedSetup?.agentName, 'Fundraiser helper');
  assert.equal(detail.goal.pinnedSetup?.modelName, 'test/fundraiser-model');
  assert.deepEqual(detail.goal.pinnedSetup?.mcpServerNames, ['files']);
  assert.deepEqual(detail.goal.pinnedSetup?.skillNames, ['planning']);

  const changedApi = createGoalsApi({
    fetcher: async () =>
      Response.json(
        {
          error: { message: 'The agent setup changed since the card was shown.', code: 'goal_setup_changed' },
          data: {
            goal: goalWire({}),
            steps: STEPS_WIRE,
            setup: { ...SETUP_WIRE, agent_name: 'Fundraiser helper, updated', digest: 'digest-2' },
          },
        },
        { status: 409 },
      ),
    client: unusedClient,
  });
  await assert.rejects(
    changedApi.activateGoal('goal-1', { expectedRevision: 1, setupDigest: 'digest-1' }),
    (error: unknown) => {
      assert.ok(error instanceof GoalSetupChangedError);
      assert.equal(error.message, 'The agent setup changed since the card was shown.');
      assert.equal(error.preview.setup.agentName, 'Fundraiser helper, updated');
      assert.equal(error.preview.setup.digest, 'digest-2');
      return true;
    },
  );
});

test('goals API surfaces the server message and rejects a malformed single read', async () => {
  const failing = createGoalsApi({
    fetcher: async () => Response.json({ error: { message: 'That goal is not yours.' } }, { status: 404 }),
    client: unusedClient,
  });
  await assert.rejects(failing.getGoal('goal-9'), /not yours/);

  const malformed = createGoalsApi({
    fetcher: async () => Response.json({ data: { goal: { nope: true } } }),
    client: unusedClient,
  });
  await assert.rejects(malformed.getGoal('goal-1'), /does not recognise/);
});

test('goals API drains the agents list across pages for the create form', async () => {
  let turned = false;
  const page = {
    data: [{ id: 'agent-1', name: 'Fundraiser helper' }],
    hasNextPage: () => !turned,
    getNextPage: () => {
      turned = true;
      page.data = [{ id: 'agent-2', name: 'Weekend planner' }];
      return Promise.resolve();
    },
  };
  const api = createGoalsApi({
    fetcher: async () => Response.json({ data: [], pagination: { limit: 100 } }),
    client: { agents: { list: () => Promise.resolve(page) } },
  });
  const agents = await api.listAgents();
  assert.deepEqual(agents, [
    { id: 'agent-1', name: 'Fundraiser helper' },
    { id: 'agent-2', name: 'Weekend planner' },
  ]);
});
