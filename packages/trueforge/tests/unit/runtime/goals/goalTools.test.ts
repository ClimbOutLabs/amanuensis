import type { CallToolResponse } from '@truefoundry/trueforge-core/core';
import { isCallToolResponseResult } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import winston from 'winston';
import { GoalToolSet } from '../../../../src/runtime/goals/goalCapability';
import { createGoalService } from '../../../../src/runtime/goals/goalService';
import {
  AGENT_ID,
  FIXED_NOW,
  FakeAgentStore,
  FakeSkillStore,
  TENANT_ID,
  fundraiserDraft,
  ownerActor,
} from './fundraiserFixture';
import { InMemoryGoalStore } from './inMemoryGoalStore';

function toolText(response: CallToolResponse): string {
  if (!isCallToolResponseResult(response)) {
    throw new Error('The tool did not answer with a result.');
  }
  const texts = response.result.content.flatMap(part => (part.type === 'text' ? [part.text] : []));
  return texts.join('\n');
}

function setup() {
  const store = new InMemoryGoalStore(() => FIXED_NOW);
  const agents = new FakeAgentStore();
  const skills = new FakeSkillStore();
  const options: ConstructorParameters<typeof GoalToolSet>[0] = {
    store,
    agentStore: agents,
    skillStore: skills,
    spaceStore: { getSpace: () => Promise.resolve(undefined) },
    tenant_id: TENANT_ID,
    owner: { subject_id: 'owner-1', subject_type: 'user', subject_display_name: 'Owner' },
    persona_id: null,
    resolve_chat_agent_id: () => Promise.resolve(AGENT_ID),
    logger: winston.createLogger({ silent: true }),
    session_id: 'chat-1',
    tracing: NOOP_AGENT_TRACING,
  };
  return { store, agents, skills, options, tools: new GoalToolSet(options) };
}

describe('goal tools', () => {
  it('makes a draft from a conversation and leaves activation to the owner', async () => {
    const { store, tools } = setup();
    const draftInput = fundraiserDraft();
    const created = toolText(
      await tools.callTool({
        name: 'create_goal',
        arguments: {
          title: draftInput.title,
          outcome: draftInput.outcome,
          success_criteria: draftInput.success_criteria,
          target_at: draftInput.target_at,
          timezone: draftInput.timezone,
          agent_name: 'fundraiser-helper',
          selected_sources: draftInput.selected_sources,
          steps: draftInput.steps.map(step => ({
            description: step.description,
            acceptance_criteria: step.acceptance_criteria,
            ...(step.depends_on_indexes === undefined ? {} : { depends_on_indexes: step.depends_on_indexes }),
            ...(step.source_refs === undefined ? {} : { source_refs: step.source_refs }),
          })),
        },
      }),
    );
    expect(created).toContain('draft');
    const goals = [...store.goals.values()];
    expect(goals).toHaveLength(1);
    expect(goals[0]?.lifecycle).toBe('draft');

    // No time of day was named for this target, so the stored draft records
    // the target as a date alone.
    expect(goals[0]?.target_has_time).toBe(false);

    const listed = toolText(await tools.callTool({ name: 'list_goals', arguments: {} }));
    expect(listed).toContain('Community fundraiser');

    const fetched = toolText(await tools.callTool({ name: 'get_goal', arguments: { goal: 'Community fundraiser' } }));
    expect(fetched).toContain('Confirm the venue');
  });

  it('records a target time when the person named one', async () => {
    const { store, tools } = setup();
    const draftInput = fundraiserDraft();
    await tools.callTool({
      name: 'create_goal',
      arguments: {
        title: draftInput.title,
        outcome: draftInput.outcome,
        target_at: draftInput.target_at,
        target_has_time: true,
        timezone: draftInput.timezone,
      },
    });
    const goals = [...store.goals.values()];
    expect(goals).toHaveLength(1);
    expect(goals[0]?.target_has_time).toBe(true);
  });

  it('runs a check from chat once the goal is active, and refuses while it is a draft', async () => {
    const { store, agents, skills, tools } = setup();
    const service = createGoalService({ store, agentStore: agents, skillStore: skills, now: () => FIXED_NOW });
    const actor = ownerActor();
    const draft = await service.createDraft(actor, fundraiserDraft());

    const refused = toolText(
      await tools.callTool({ name: 'request_goal_check', arguments: { goal: draft.goal.goal_id } }),
    );
    expect(refused).toContain('Activate it before asking for a check');

    const preview = await service.previewActivation(actor, draft.goal.goal_id);
    await service.activate(actor, draft.goal.goal_id, {
      expected_revision: preview.goal.revision,
      setup_digest: preview.setup.digest,
    });

    // The chat check reads the goal's space sources through the space store. The
    // fixture spaces are absent here, so the check reports them unread and still
    // completes honestly rather than inventing findings.
    const checked: unknown = JSON.parse(
      toolText(await tools.callTool({ name: 'request_goal_check', arguments: { goal: draft.goal.goal_id } })),
    );
    expect(checked).toMatchObject({ outcome: 'nothing_changed', unread_sources: ['Venue letter', 'Catering quote'] });
    const cycles = [...store.cycles.values()];
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.outcome).toBe('nothing_changed');
  });
});
