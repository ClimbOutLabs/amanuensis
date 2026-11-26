/**
 * Regression: Check now on a chat-shaped goal. The button posts to the real
 * route, which runs the real check over the real store. A check whose goal
 * gives it nothing it can read (no sources selected, or only kinds the host
 * has no reader for) used to finish as "nothing changed" with the detail
 * "Nothing new in the selected sources since the last check", a claim the
 * check never earned: it read nothing at all, so the click looked exactly
 * like doing nothing. Such a check must finish as failed, with the plain
 * reason on the cycle, while a check that did read its sources and found
 * them unchanged still reports nothing changed.
 */
import { Hono } from 'hono';
import { createGoalsRouter } from '../../../../src/apis/goals';
import type { RequestContext } from '../../../../src/auth/identity';
import { GoalStore } from '../../../../src/db/goalStore';
import type { SpaceRecord } from '../../../../src/db/spaceStore';
import { createGoalService, type CreateGoalDraftInput } from '../../../../src/runtime/goals/goalService';
import { createGoalStoreAdapter } from '../../../../src/runtime/goals/goalStoreAdapter';
import { GoalCheckResponseSchema, type GoalCheckResult } from '../../../../src/schemas/goal';
import {
  AGENT_ID,
  FakeAgentStore,
  FakeSkillStore,
  FIXED_NOW,
  OWNER_SUBJECT_ID,
  ownerActor,
  TENANT_ID,
} from '../../../unit/runtime/goals/fundraiserFixture';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

function requestContext(): RequestContext {
  return {
    tenant_id: TENANT_ID,
    subject: { id: OWNER_SUBJECT_ID, type: 'user', display_name: 'Owner' },
    roles: [],
    user_credential: null,
  };
}

function spaceRecord(input: { id: string; body: string; revision: number }): SpaceRecord {
  return {
    tenant_id: TENANT_ID,
    created_by: OWNER_SUBJECT_ID,
    id: input.id,
    revision: input.revision,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-17T10:00:00.000Z',
    name: input.id,
    purpose: 'An invented notice board the goal reads.',
    status: 'active',
    body: input.body,
    format: 'markdown',
  };
}

interface Harness {
  app: Hono;
  goalId: string;
}

async function activeGoalOverRouter(
  env: SqliteTestDatabase,
  draft: Omit<CreateGoalDraftInput, 'agent_id' | 'timezone' | 'target_at'> & { target_at?: string | null },
  spaces?: Map<string, SpaceRecord>,
): Promise<Harness> {
  const store = createGoalStoreAdapter({ store: new GoalStore(env.db), db: env.db });
  const service = createGoalService({
    store,
    agentStore: new FakeAgentStore(),
    skillStore: new FakeSkillStore(),
    now: () => FIXED_NOW,
  });
  const actor = ownerActor('persona-1');
  const created = await service.createDraft(actor, {
    agent_id: AGENT_ID,
    timezone: 'UTC',
    target_at: null,
    ...draft,
  });
  const preview = await service.previewActivation(actor, created.goal.goal_id);
  await service.activate(actor, created.goal.goal_id, {
    expected_revision: preview.goal.revision,
    setup_digest: preview.setup.digest,
  });
  const app = new Hono();
  app.route(
    '/api/v1/goals',
    createGoalsRouter({
      resolveGoalStore: () => store,
      resolveAgentStore: () => new FakeAgentStore(),
      resolveSkillStore: () => new FakeSkillStore(),
      resolveSpaceStore: () => ({
        getSpace: (input: { space_id: string }) => Promise.resolve(spaces?.get(input.space_id)),
      }),
      resolveRequestContext: () => requestContext(),
    }),
  );
  return { app, goalId: created.goal.goal_id };
}

async function postCheck(app: Hono, goalId: string): Promise<GoalCheckResult> {
  const response = await app.request(`/api/v1/goals/${goalId}/check`, { method: 'POST' });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const parsed = GoalCheckResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`The check response did not match the wire schema: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data.data;
}

describe('check now on a chat-shaped goal, through the real route and store', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  });

  afterEach(async () => {
    await env.teardown();
  });

  it('says plainly that a goal with no sources gave the check nothing to read', async () => {
    const { app, goalId } = await activeGoalOverRouter(env, {
      title: 'Paperwork submission',
      outcome: 'Both applications are submitted complete and on time.',
      success_criteria: ['The application form is filled in for both people', 'The fee receipt is in hand'],
      selected_sources: [],
      steps: [{ description: 'Confirm the office received the package', acceptance_criteria: '', source_refs: [] }],
    });

    const data = await postCheck(app, goalId);
    expect(data.cycle.outcome).toBe('failed');
    expect(data.cycle.outcome_detail).toContain('no sources selected');
    expect(data.new_evidence).toHaveLength(0);
  });

  it('says plainly when none of the selected sources could be read', async () => {
    const { app, goalId } = await activeGoalOverRouter(env, {
      title: 'Paperwork submission',
      outcome: 'Both applications are submitted complete and on time.',
      success_criteria: ['The application form is filled in for both people', 'The fee receipt is in hand'],
      selected_sources: [
        { source_kind: 'mail', source_ref: 'inbox', label: 'Email' },
        { source_kind: 'document', source_ref: 'letter-1', label: 'Office letter' },
      ],
      steps: [
        {
          description: 'Confirm the office received the package',
          acceptance_criteria: '',
          source_refs: ['inbox', 'letter-1'],
        },
      ],
    });

    const data = await postCheck(app, goalId);
    expect(data.cycle.outcome).toBe('failed');
    expect(data.cycle.outcome_detail).toContain('could not look for changes');
    expect(data.unread_sources.map(source => source.source_ref)).toEqual(['inbox', 'letter-1']);
    expect(data.new_evidence).toHaveLength(0);
  });

  it('still reports nothing changed when the check read its source and found it unchanged', async () => {
    const spaces = new Map([
      ['notice-board', spaceRecord({ id: 'notice-board', body: 'The hall is free on Saturday.', revision: 3 })],
    ]);
    const { app, goalId } = await activeGoalOverRouter(
      env,
      {
        title: 'Hall booking',
        outcome: 'The hall is booked for the fair.',
        success_criteria: ['The hall booking is confirmed'],
        selected_sources: [{ source_kind: 'space', source_ref: 'notice-board', label: 'Notice board' }],
        steps: [
          {
            description: 'Read the notice board',
            acceptance_criteria: 'The hall booking is confirmed',
            source_refs: ['notice-board'],
          },
        ],
      },
      spaces,
    );

    const first = await postCheck(app, goalId);
    expect(first.cycle.outcome).toBe('completed');
    expect(first.new_evidence).toHaveLength(1);

    const second = await postCheck(app, goalId);
    expect(second.cycle.outcome).toBe('nothing_changed');
    expect(second.new_evidence).toHaveLength(0);
  });
});
