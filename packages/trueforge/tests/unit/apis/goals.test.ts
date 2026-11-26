import { Hono } from 'hono';
import { createGoalsRouter } from '../../../src/apis/goals';
import type { RequestContext } from '../../../src/auth/identity';
import type { SpaceRecord } from '../../../src/db/spaceStore';
import {
  AGENT_ID,
  CATERING_QUOTE_READ,
  FakeAgentStore,
  FakeSkillStore,
  fundraiserDraft,
  fundraiserManifest,
  OTHER_SUBJECT_ID,
  OWNER_SUBJECT_ID,
  TENANT_ID,
  VENUE_LETTER_READ,
} from '../runtime/goals/fundraiserFixture';
import { InMemoryGoalStore } from '../runtime/goals/inMemoryGoalStore';

function requestContext(subjectId: string): RequestContext {
  return {
    tenant_id: TENANT_ID,
    subject: { id: subjectId, type: 'user', display_name: 'Owner' },
    roles: [],
    user_credential: null,
  };
}

function spaceRecord(input: { id: string; body: string; revision: number; updated_at: string }): SpaceRecord {
  return {
    tenant_id: TENANT_ID,
    created_by: OWNER_SUBJECT_ID,
    id: input.id,
    revision: input.revision,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: input.updated_at,
    name: input.id,
    purpose: 'An invented document the fundraiser goal reads.',
    status: 'active',
    body: input.body,
    format: 'markdown',
  };
}

function fundraiserSpaces(): Map<string, SpaceRecord> {
  return new Map([
    [
      'venue-letter',
      spaceRecord({
        id: 'venue-letter',
        body: VENUE_LETTER_READ.content,
        revision: 3,
        updated_at: '2026-11-17T10:00:00.000Z',
      }),
    ],
    [
      'catering-quote',
      spaceRecord({
        id: 'catering-quote',
        body: CATERING_QUOTE_READ.content,
        revision: 1,
        updated_at: '2026-11-16T10:00:00.000Z',
      }),
    ],
  ]);
}

function setup(
  subjectId: string = OWNER_SUBJECT_ID,
  shared?: { store: InMemoryGoalStore },
  spaces?: Map<string, SpaceRecord>,
) {
  const store = shared?.store ?? new InMemoryGoalStore();
  const agents = new FakeAgentStore();
  const skills = new FakeSkillStore();
  const app = new Hono();
  app.route(
    '/api/v1/goals',
    createGoalsRouter({
      resolveGoalStore: () => store,
      resolveAgentStore: () => agents,
      resolveSkillStore: () => skills,
      resolveSpaceStore: () => ({
        getSpace: (input: { space_id: string }) => Promise.resolve(spaces?.get(input.space_id)),
      }),
      resolveRequestContext: () => requestContext(subjectId),
    }),
  );
  return { store, agents, skills, app };
}

interface JsonBody {
  data?: unknown;
  error?: { message?: string; code?: string };
  pagination?: { limit?: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(json: JsonBody): Record<string, unknown> {
  if (!isRecord(json.data)) {
    throw new Error('The response carried no data object.');
  }
  return json.data;
}

function goalOf(json: JsonBody): Record<string, unknown> {
  const goal = dataOf(json)['goal'];
  if (!isRecord(goal)) {
    throw new Error('The response carried no goal.');
  }
  return goal;
}

function setupOf(json: JsonBody): Record<string, unknown> {
  const setup = dataOf(json)['setup'];
  if (!isRecord(setup)) {
    throw new Error('The response carried no setup.');
  }
  return setup;
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function stepsOf(json: JsonBody): Record<string, unknown>[] {
  return recordsOf(dataOf(json)['steps']);
}

function eventsOf(json: JsonBody): Record<string, unknown>[] {
  return recordsOf(json.data);
}

function stepNamed(steps: Record<string, unknown>[], description: string): Record<string, unknown> {
  const step = steps.find(candidate => candidate['description'] === description);
  if (step === undefined) {
    throw new Error(`The response carried no step named ${description}.`);
  }
  return step;
}

async function call(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: JsonBody }> {
  const response = await app.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json();
  return { status: response.status, json: isRecord(json) ? json : {} };
}

function createBody() {
  const draft = fundraiserDraft();
  return {
    agent_id: draft.agent_id,
    title: draft.title,
    outcome: draft.outcome,
    success_criteria: draft.success_criteria,
    target_at: draft.target_at,
    timezone: draft.timezone,
    selected_sources: draft.selected_sources,
    steps: draft.steps.map(step => ({
      description: step.description,
      depends_on_indexes: step.depends_on_indexes ?? [],
      acceptance_criteria: step.acceptance_criteria,
      source_refs: step.source_refs ?? [],
    })),
  };
}

describe('goals API', () => {
  it('creates a draft, previews the card, and activates against the digest it showed', async () => {
    const { app } = setup();
    const created = await call(app, 'POST', '/api/v1/goals', createBody());
    expect(created.status).toBe(201);
    const goalId = goalOf(created.json)['goal_id'];
    expect(typeof goalId).toBe('string');
    expect(goalOf(created.json)['lifecycle']).toBe('draft');
    expect(dataOf(created.json)['next_step_id']).not.toBeNull();

    const preview = await call(app, 'GET', `/api/v1/goals/${String(goalId)}/activation-preview`);
    expect(preview.status).toBe(200);
    const digest = setupOf(preview.json)['digest'];
    const revision = goalOf(preview.json)['revision'];
    expect(typeof digest).toBe('string');

    const activated = await call(app, 'POST', `/api/v1/goals/${String(goalId)}/activate`, {
      expected_revision: revision,
      setup_digest: digest,
    });
    expect(activated.status).toBe(200);
    expect(goalOf(activated.json)['lifecycle']).toBe('active');
    expect(goalOf(activated.json)['pinned_agent_id']).toBe(AGENT_ID);

    const paused = await call(app, 'POST', `/api/v1/goals/${String(goalId)}/pause`, {
      expected_revision: goalOf(activated.json)['revision'],
    });
    expect(paused.status).toBe(200);
    expect(goalOf(paused.json)['lifecycle']).toBe('paused');

    const events = await call(app, 'GET', `/api/v1/goals/${String(goalId)}/events`);
    expect(events.status).toBe(200);
    expect(events.json.pagination?.limit).toBeGreaterThan(0);
    expect(Array.isArray(events.json.data)).toBe(true);
  });

  it('answers a stale activation with the updated card instead of activating', async () => {
    const { app, agents } = setup();
    const created = await call(app, 'POST', '/api/v1/goals', createBody());
    const goalId = String(goalOf(created.json)['goal_id']);
    const preview = await call(app, 'GET', `/api/v1/goals/${goalId}/activation-preview`);
    agents.changeManifest(AGENT_ID, fundraiserManifest('Changed after the card was shown.'));

    const refused = await call(app, 'POST', `/api/v1/goals/${goalId}/activate`, {
      expected_revision: goalOf(preview.json)['revision'],
      setup_digest: setupOf(preview.json)['digest'],
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('goal_setup_changed');
    expect(setupOf(refused.json)['digest']).not.toBe(setupOf(preview.json)['digest']);

    const after = await call(app, 'GET', `/api/v1/goals/${goalId}`);
    expect(goalOf(after.json)['lifecycle']).toBe('draft');
  });

  it('carries whether the target has a time from create through update, defaulting to a date alone', async () => {
    const { app } = setup();
    const plain = await call(app, 'POST', '/api/v1/goals', createBody());
    expect(plain.status).toBe(201);
    expect(goalOf(plain.json)['target_has_time']).toBe(false);

    const timed = await call(app, 'POST', '/api/v1/goals', { ...createBody(), target_has_time: true });
    expect(timed.status).toBe(201);
    expect(goalOf(timed.json)['target_has_time']).toBe(true);
    const goalId = String(goalOf(timed.json)['goal_id']);

    const updated = await call(app, 'PUT', `/api/v1/goals/${goalId}`, {
      expected_revision: goalOf(timed.json)['revision'],
      target_at: '2027-06-15T07:00:00.000Z',
      target_has_time: false,
    });
    expect(updated.status).toBe(200);
    expect(goalOf(updated.json)['target_at']).toBe('2027-06-15T07:00:00.000Z');
    expect(goalOf(updated.json)['target_has_time']).toBe(false);
  });

  it('refuses a check on a draft goal and hides the goal from another owner', async () => {
    const shared = { store: new InMemoryGoalStore() };
    const { app } = setup(OWNER_SUBJECT_ID, shared);
    const created = await call(app, 'POST', '/api/v1/goals', createBody());
    const goalId = String(goalOf(created.json)['goal_id']);

    const checked = await call(app, 'POST', `/api/v1/goals/${goalId}/check`);
    expect(checked.status).toBe(400);
    expect(checked.json.error?.message).toContain('Activate it before asking for a check');

    const { app: otherApp } = setup(OTHER_SUBJECT_ID, shared);
    const hidden = await call(otherApp, 'GET', `/api/v1/goals/${goalId}`);
    expect(hidden.status).toBe(404);
    const list = await call(otherApp, 'GET', '/api/v1/goals');
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual([]);
  });

  it('checks a goal, confirms its first step, and reads the confirmation back', async () => {
    const spaces = fundraiserSpaces();
    const shared = { store: new InMemoryGoalStore() };
    const { app } = setup(OWNER_SUBJECT_ID, shared, spaces);
    const created = await call(app, 'POST', '/api/v1/goals', createBody());
    const goalId = String(goalOf(created.json)['goal_id']);
    const preview = await call(app, 'GET', `/api/v1/goals/${goalId}/activation-preview`);
    const activated = await call(app, 'POST', `/api/v1/goals/${goalId}/activate`, {
      expected_revision: goalOf(preview.json)['revision'],
      setup_digest: setupOf(preview.json)['digest'],
    });
    expect(activated.status).toBe(200);

    // The check reads the goal's spaces and attaches the venue letter as
    // evidence on the first step. Attaching evidence leaves the step
    // unconfirmed, and the equipment step stays blocked behind it.
    const checked = await call(app, 'POST', `/api/v1/goals/${goalId}/check`);
    expect(checked.status).toBe(200);
    const checkedSteps = stepsOf(checked.json);
    const venueStep = stepNamed(checkedSteps, 'Confirm the venue');
    expect(venueStep['status']).toBe('ready');
    expect(venueStep['evidence_ids']).toHaveLength(1);
    expect(stepNamed(checkedSteps, 'Book the equipment')['status']).toBe('planned');
    const venueStepId = String(venueStep['step_id']);
    const equipmentStepId = String(stepNamed(checkedSteps, 'Book the equipment')['step_id']);

    // Confirming the first step makes the second one eligible, and the goal
    // itself stays active rather than completing.
    const confirmed = await call(app, 'POST', `/api/v1/goals/${goalId}/steps/${venueStepId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(goalOf(confirmed.json)['lifecycle']).toBe('active');
    const confirmedSteps = stepsOf(confirmed.json);
    expect(stepNamed(confirmedSteps, 'Confirm the venue')['status']).toBe('owner_confirmed');
    expect(stepNamed(confirmedSteps, 'Book the equipment')['status']).toBe('ready');
    expect(dataOf(confirmed.json)['next_step_id']).toBe(equipmentStepId);

    // The confirmation reads back on the goal's history: who confirmed,
    // which step, and when.
    const events = await call(app, 'GET', `/api/v1/goals/${goalId}/events`);
    expect(events.status).toBe(200);
    const confirmation = eventsOf(events.json).find(event => event['event_type'] === 'goal_step_confirmed');
    expect(confirmation).toBeDefined();
    expect(confirmation?.['actor']).toBe(OWNER_SUBJECT_ID);
    const payload = confirmation?.['payload'];
    expect(isRecord(payload)).toBe(true);
    expect(isRecord(payload) ? payload['step_id'] : undefined).toBe(venueStepId);
    expect(isRecord(payload) ? payload['confirmed_by'] : undefined).toBe(OWNER_SUBJECT_ID);
    expect(typeof confirmation?.['created_at']).toBe('string');

    // A second confirmation of the same step refuses cleanly.
    const again = await call(app, 'POST', `/api/v1/goals/${goalId}/steps/${venueStepId}/confirm`);
    expect(again.status).toBe(400);
    expect(again.json.error?.message).toContain('already confirmed');

    // Another owner cannot confirm a step on this goal.
    const { app: otherApp } = setup(OTHER_SUBJECT_ID, shared, spaces);
    const hidden = await call(otherApp, 'POST', `/api/v1/goals/${goalId}/steps/${equipmentStepId}/confirm`);
    expect(hidden.status).toBe(404);

    // A draft goal refuses confirmation.
    const draftCreated = await call(app, 'POST', '/api/v1/goals', createBody());
    const draftId = String(goalOf(draftCreated.json)['goal_id']);
    const draftFirstStep = stepsOf(draftCreated.json)[0];
    expect(draftFirstStep).toBeDefined();
    const draftConfirm = await call(
      app,
      'POST',
      `/api/v1/goals/${draftId}/steps/${String(draftFirstStep?.['step_id'])}/confirm`,
    );
    expect(draftConfirm.status).toBe(400);
    expect(draftConfirm.json.error?.message).toContain('still a draft');
  });
});
