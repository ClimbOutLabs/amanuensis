import type { AgentSpec, CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { createHash } from 'node:crypto';
import { AgentNameConflictError, type AgentRecord, type IAgentStore } from '../db/agentStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { ScheduleRecord } from '../db/scheduleStore';
import type { Persona } from '../personas/persona';

/** The description on the agent the host makes so a plain chat's schedules can run. */
export const CHAT_ASSISTANT_DESCRIPTION = 'Runs the schedules you make in a chat.';

const CHAT_ASSISTANT_NAME_PREFIX = 'assistant-';
const UNNAMED_ASSISTANT = 'Your assistant';

/** Who a schedule made in one chat runs as, settled by the host so the model never names it. */
export interface ChatAssistant {
  /** The persona or assistant name, for the "runs as" line. */
  display_name: string;
  persona_id: string | null;
  /** Changes whenever the chat's assistant does, so an approval covers only the one it was shown. */
  approval_key: string;
  /** The stored agent the schedule binds to. A plain chat's is made on first use, so call it only once approved. */
  agent: () => Promise<AgentRecord>;
}

/** What runs the chat: its saved agent, or a plain chat's own setup. */
export type ChatRunner = { kind: 'saved'; agent: AgentRecord } | { kind: 'plain'; spec: AgentSpec };

/** Thrown when the stored agent for a plain chat could not be made. */
export class ChatAssistantUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      'Nothing was saved because this chat could not be set up to run schedules. Ask the user to make it on the Schedules page instead.',
      options,
    );
    this.name = 'ChatAssistantUnavailableError';
  }
}

/** An agent the host made for its owner's schedules, as opposed to one the person saved and named. */
export function isChatAssistantAgent(input: { agent: AgentRecord; owner: CreatedBySubject }): boolean {
  return input.agent.host_managed && input.agent.created_by_subject.subject_id === input.owner.subject_id;
}

/** One name per owner and setup, so chats set up alike share one stored agent and a changed setup gets its own. */
export function chatAssistantAgentName(input: { owner: CreatedBySubject; spec: AgentSpec }): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ owner: input.owner.subject_id, spec: input.spec }))
    .digest('hex');
  return `${CHAT_ASSISTANT_NAME_PREFIX}${digest.slice(0, 16)}`;
}

export async function getOrCreateChatAssistantAgent(input: {
  tenant_id: string;
  owner: CreatedBySubject;
  name: string;
  spec: AgentSpec;
  agentStore: Pick<IAgentStore<unknown>, 'getAgent' | 'createAgent'>;
}): Promise<AgentRecord> {
  const { tenant_id, owner, name, spec, agentStore } = input;
  const reuse = async (): Promise<AgentRecord | undefined> => {
    const existing = await agentStore.getAgent({ tenant_id, name });
    if (existing === undefined) {
      return undefined;
    }
    if (!isChatAssistantAgent({ agent: existing, owner })) {
      throw new ChatAssistantUnavailableError();
    }
    return existing;
  };
  const existing = await reuse();
  if (existing !== undefined) {
    return existing;
  }
  try {
    return await agentStore.createAgent({
      tenant_id,
      name,
      description: CHAT_ASSISTANT_DESCRIPTION,
      manifest: spec,
      external_id: null,
      host_managed: true,
      created_by_subject: owner,
    });
  } catch (error) {
    if (!(error instanceof AgentNameConflictError)) {
      throw error;
    }
    // Another schedule from a chat set up the same way made it first.
    const raced = await reuse();
    if (raced === undefined) {
      throw new ChatAssistantUnavailableError({ cause: error });
    }
    return raced;
  }
}

/** The model a chat's turns run on, which a persona created in that chat answers with. */
export function chatModelName(runner: ChatRunner): string {
  return runner.kind === 'plain' ? runner.spec.model.name : runner.agent.manifest.model.name;
}

/** The assistant a chat's turn runs as right now, for a schedule made in that chat. */
export function resolveChatAssistant(input: {
  tenant_id: string;
  owner: CreatedBySubject;
  runner: ChatRunner;
  persona: Persona | undefined;
  /** The name the owner gave their assistant; null when unset. */
  assistantName: string | null;
  agentStore: Pick<IAgentStore<unknown>, 'getAgent' | 'createAgent'>;
}): ChatAssistant {
  const { runner, persona } = input;
  const persona_id = persona?.id ?? null;
  const personaKey = `persona:${persona_id ?? 'none'}`;
  if (runner.kind === 'saved') {
    return {
      display_name: persona?.display_name ?? runner.agent.name,
      persona_id,
      approval_key: `agent:${runner.agent.id}|${personaKey}`,
      agent: () => Promise.resolve(runner.agent),
    };
  }
  const name = chatAssistantAgentName({ owner: input.owner, spec: runner.spec });
  return {
    display_name: persona?.display_name ?? input.assistantName ?? UNNAMED_ASSISTANT,
    persona_id,
    approval_key: `chat:${name}|${personaKey}`,
    agent: () =>
      getOrCreateChatAssistantAgent({
        tenant_id: input.tenant_id,
        owner: input.owner,
        name,
        spec: runner.spec,
        agentStore: input.agentStore,
      }),
  };
}

/**
 * Who a saved schedule runs as, in plain words: its persona, the assistant for a chat-made agent, else the agent.
 * Names come from the schedule's creator, so the chat and the Schedules page show the same thing.
 */
export function scheduleRunsAs(input: {
  tenant_id: string;
  agentStore: Pick<IAgentStore<unknown>, 'getAgent'>;
  personaStore: Pick<IPersonaStore<unknown>, 'getPersona'>;
  personalizationStore: Pick<IPersonalizationStore<unknown>, 'getProfile'>;
}): (schedule: ScheduleRecord) => Promise<string> {
  const { tenant_id } = input;
  const personas = new Map<string, Promise<Persona | undefined>>();
  const agents = new Map<string, Promise<AgentRecord | undefined>>();
  const assistantNames = new Map<string, Promise<string | null>>();
  const cached = <T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    const hit = map.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const loading = load();
    map.set(key, loading);
    return loading;
  };
  return async schedule => {
    const owner = schedule.created_by_subject;
    const { persona_id } = schedule;
    if (persona_id !== null) {
      const persona = await cached(personas, `${owner.subject_id}\n${persona_id}`, () =>
        input.personaStore.getPersona({ tenant_id, created_by: owner.subject_id, id: persona_id }),
      );
      if (persona !== undefined) {
        return persona.display_name;
      }
    }
    const agent = await cached(agents, schedule.agent_id, () =>
      input.agentStore.getAgent({ tenant_id, id: schedule.agent_id }),
    );
    if (agent === undefined || !isChatAssistantAgent({ agent, owner })) {
      return schedule.agent_name;
    }
    const assistantName = await cached(assistantNames, owner.subject_id, async () => {
      const profile = await input.personalizationStore.getProfile({ tenant_id, created_by: owner.subject_id });
      return profile?.assistant_name ?? null;
    });
    return assistantName ?? UNNAMED_ASSISTANT;
  };
}
