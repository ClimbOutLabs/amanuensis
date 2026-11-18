/**
 * The invented community fundraiser every goal test runs on, plus the small
 * fake stores the service and tools need. No real person, place, or document
 * appears anywhere in here.
 */
import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { AgentRecord, GetAgentInput } from '../../../../src/db/agentStore';
import type { SkillRecord } from '../../../../src/db/skillStore';
import type { GoalSourceRead, GoalSourceReader } from '../../../../src/runtime/goals/goalCheck';
import type { CreateGoalDraftInput, GoalActor } from '../../../../src/runtime/goals/goalService';
import type { GoalRecord } from '../../../../src/runtime/goals/goalStorePort';
import { SkillManifestSchema } from '../../../../src/schemas/skill';

export const TENANT_ID = 'tenant-1';
export const OWNER_SUBJECT_ID = 'owner-1';
export const OTHER_SUBJECT_ID = 'owner-2';
export const AGENT_ID = 'agent-fundraiser';
export const FIXED_NOW = new Date('2026-11-18T12:00:00.000Z');

export function ownerActor(persona_id?: string): GoalActor {
  return { tenant_id: TENANT_ID, subject_id: OWNER_SUBJECT_ID, persona_id };
}

export function otherActor(): GoalActor {
  return { tenant_id: TENANT_ID, subject_id: OTHER_SUBJECT_ID, persona_id: undefined };
}

export function fundraiserManifest(instructions = 'Help the owner run the community fundraiser.'): AgentSpec {
  return AgentSpecSchema.parse({
    model: { name: 'test/model' },
    instructions,
    mcp_servers: [{ name: 'mail' }],
    skills: [{ name: 'venue-finder', preload: true }],
  });
}

export function fundraiserAgent(manifest: AgentSpec = fundraiserManifest()): AgentRecord {
  return {
    id: AGENT_ID,
    tenant_id: TENANT_ID,
    name: 'fundraiser-helper',
    description: 'Helps run the community fundraiser.',
    manifest,
    external_id: null,
    host_managed: false,
    created_by_subject: {
      subject_id: OWNER_SUBJECT_ID,
      subject_type: 'user',
      subject_display_name: 'Owner',
    },
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-10T09:00:00.000Z',
  };
}

/** The saved agents a test runs against, with a way to change one as its owner would. */
export class FakeAgentStore {
  readonly #agents = new Map<string, AgentRecord>();

  constructor(records: readonly AgentRecord[] = [fundraiserAgent()]) {
    for (const record of records) {
      this.#agents.set(record.id, record);
    }
  }

  async getAgent(input: GetAgentInput): Promise<AgentRecord | undefined> {
    await Promise.resolve();
    const record =
      'id' in input ? this.#agents.get(input.id) : [...this.#agents.values()].find(agent => agent.name === input.name);
    if (record?.tenant_id !== input.tenant_id) {
      return undefined;
    }
    return record;
  }

  async listAgents(input: { tenant_id: string }): Promise<AgentRecord[]> {
    await Promise.resolve();
    return [...this.#agents.values()].filter(record => record.tenant_id === input.tenant_id);
  }

  /** Change the saved setup the way editing the agent in Settings would, version stamp included. */
  changeManifest(agent_id: string, manifest: AgentSpec): void {
    const record = this.#agents.get(agent_id);
    if (record === undefined) {
      throw new Error(`No fixture agent ${agent_id}`);
    }
    this.#agents.set(agent_id, { ...record, manifest, updated_at: '2026-11-18T11:00:00.000Z' });
  }
}

export function venueFinderSkill(): SkillRecord {
  return {
    tenant_id: TENANT_ID,
    name: 'venue-finder',
    manifest: SkillManifestSchema.parse({
      type: 'git',
      name: 'venue-finder',
      url: 'https://github.com/example/venue-finder.git',
      ref: 'main',
      description: 'Finds and checks community venues.',
    }),
    network_approval: null,
    network_approval_code_sha: null,
    network_allowed_hosts: [],
    network_denied_hosts: [],
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-05T09:00:00.000Z',
  };
}

/** The saved skills a test runs against. */
export class FakeSkillStore {
  readonly #skills = new Map<string, SkillRecord>();

  constructor(records: readonly SkillRecord[] = [venueFinderSkill()]) {
    for (const record of records) {
      this.#skills.set(record.name, record);
    }
  }

  async listSkills(input: { tenant_id: string; names?: readonly string[] }): Promise<SkillRecord[]> {
    await Promise.resolve();
    return [...this.#skills.values()].filter(
      record =>
        record.tenant_id === input.tenant_id && (input.names === undefined || input.names.includes(record.name)),
    );
  }
}

/** The fundraiser draft, exactly as the chat tools or the API would carry it. */
export function fundraiserDraft(): CreateGoalDraftInput {
  return {
    agent_id: AGENT_ID,
    title: 'Community fundraiser',
    outcome: 'The fundraiser is ready to run, with the venue, equipment, and volunteers confirmed.',
    success_criteria: ['The venue is confirmed in writing', 'The equipment is booked', 'Five volunteers are confirmed'],
    target_at: '2027-06-15T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
    selected_sources: [
      { source_kind: 'space', source_ref: 'venue-letter', label: 'Venue letter' },
      { source_kind: 'space', source_ref: 'catering-quote', label: 'Catering quote' },
    ],
    steps: [
      {
        description: 'Confirm the venue',
        acceptance_criteria: 'The venue letter confirms the hall for the fundraiser date.',
        source_refs: ['venue-letter'],
      },
      {
        description: 'Book the equipment',
        depends_on_indexes: [0],
        acceptance_criteria: 'The sound and lighting hire is booked.',
      },
      {
        description: 'Confirm the volunteers',
        acceptance_criteria: 'Five volunteers have confirmed they can help.',
      },
    ],
  };
}

export const VENUE_LETTER_READ: GoalSourceRead = {
  content: 'Dear organiser, the community hall is confirmed for the fundraiser on 15 June. The deposit is paid.',
  source_revision: 'space-revision:3',
  claimed_event_at: '2026-11-17T10:00:00.000Z',
};

export const CATERING_QUOTE_READ: GoalSourceRead = {
  content: 'Catering quote: sandwiches and drinks for 120 guests, 480 in total.',
  source_revision: 'space-revision:1',
  claimed_event_at: '2026-11-16T10:00:00.000Z',
};

/**
 * A reader over an invented document world. It records every source it was
 * asked to read, so a test can prove a source outside the goal's selected
 * scope was never even asked for. The sponsor ledger exists in this world but
 * is not one of the goal's selected sources.
 */
export class FixtureSourceReader implements GoalSourceReader {
  readonly askedFor: string[] = [];
  readonly #world = new Map<string, GoalSourceRead>([
    ['venue-letter', VENUE_LETTER_READ],
    ['catering-quote', CATERING_QUOTE_READ],
    [
      'sponsor-ledger',
      {
        content: 'Sponsor ledger: two sponsors, amounts private.',
        source_revision: 'space-revision:9',
        claimed_event_at: null,
      },
    ],
  ]);

  async read(input: { goal: GoalRecord; source: { source_ref: string } }): Promise<GoalSourceRead | undefined> {
    await Promise.resolve();
    this.askedFor.push(input.source.source_ref);
    return this.#world.get(input.source.source_ref);
  }
}
