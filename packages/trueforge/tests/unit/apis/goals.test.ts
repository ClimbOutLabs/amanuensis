import { Hono } from 'hono';
import { createGoalsRouter } from '../../../src/apis/goals';
import type { RequestContext } from '../../../src/auth/identity';
import {
  AGENT_ID,
  FakeAgentStore,
  FakeSkillStore,
  OTHER_SUBJECT_ID,
  OWNER_SUBJECT_ID,
  TENANT_ID,
  fundraiserDraft,
  fundraiserManifest,
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

function setup(subjectId: string = OWNER_SUBJECT_ID, shared?: { store: InMemoryGoalStore }) {
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
      resolveSpaceStore: () => ({ getSpace: () => Promise.resolve(undefined) }),
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
  const goal = dataOf(json).goal;
  if (!isRecord(goal)) {
    throw new Error('The response carried no goal.');
  }
  return goal;
}

function setupOf(json: JsonBody): Record<string, unknown> {
  const setup = dataOf(json).setup;
  if (!isRecord(setup)) {
    throw new Error('The response carried no setup.');
  }
  return setup;
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
    const goalId = goalOf(created.json).goal_id;
    expect(typeof goalId).toBe('string');
    expect(goalOf(created.json).lifecycle).toBe('draft');
    expect(dataOf(created.json).next_step_id).not.toBeNull();

    const preview = await call(app, 'GET', `/api/v1/goals/${String(goalId)}/activation-preview`);
    expect(preview.status).toBe(200);
    const digest = setupOf(preview.json).digest;
    const revision = goalOf(preview.json).revision;
    expect(typeof digest).toBe('string');

    const activated = await call(app, 'POST', `/api/v1/goals/${String(goalId)}/activate`, {
      expected_revision: revision,
      setup_digest: digest,
    });
    expect(activated.status).toBe(200);
    expect(goalOf(activated.json).lifecycle).toBe('active');
    expect(goalOf(activated.json).pinned_agent_id).toBe(AGENT_ID);

    const paused = await call(app, 'POST', `/api/v1/goals/${String(goalId)}/pause`, {
      expected_revision: goalOf(activated.json).revision,
    });
    expect(paused.status).toBe(200);
    expect(goalOf(paused.json).lifecycle).toBe('paused');

    const events = await call(app, 'GET', `/api/v1/goals/${String(goalId)}/events`);
    expect(events.status).toBe(200);
    expect(events.json.pagination?.limit).toBeGreaterThan(0);
    expect(Array.isArray(events.json.data)).toBe(true);
  });

  it('answers a stale activation with the updated card instead of activating', async () => {
    const { app, agents } = setup();
    const created = await call(app, 'POST', '/api/v1/goals', createBody());
    const goalId = String(goalOf(created.json).goal_id);
    const preview = await call(app, 'GET', `/api/v1/goals/${goalId}/activation-preview`);
    agents.changeManifest(AGENT_ID, fundraiserManifest('Changed after the card was shown.'));

    const refused = await call(app, 'POST', `/api/v1/goals/${goalId}/activate`, {
      expected_revision: goalOf(preview.json).revision,
      setup_digest: setupOf(preview.json).digest,
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code).toBe('goal_setup_changed');
    expect(setupOf(refused.json).digest).not.toBe(setupOf(preview.json).digest);

    const after = await call(app, 'GET', `/api/v1/goals/${goalId}`);
    expect(goalOf(after.json).lifecycle).toBe('draft');
  });

  it('refuses a check on a draft goal and hides the goal from another owner', async () => {
    const shared = { store: new InMemoryGoalStore() };
    const { app } = setup(OWNER_SUBJECT_ID, shared);
    const created = await call(app, 'POST', '/api/v1/goals', createBody());
    const goalId = String(goalOf(created.json).goal_id);

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
});
