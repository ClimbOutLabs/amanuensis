import type { AgentSpec, CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { createHash } from 'node:crypto';
import { AgentNameConflictError, type AgentRecord, type IAgentStore } from '../db/agentStore';
import type { IPersonaStore } from '../db/personaStore';
import type { ScheduleRecord } from '../db/scheduleStore';
import type { Persona } from '../personas/persona';

/** The description on the agent the host makes so a plain chat's schedules can run. */
export const CHAT_ASSISTANT_DESCRIPTION = 'Runs the schedules you make in a chat.';

const CHAT_ASSISTANT_NAME_PREFIX = 'assistant-';

/**
 * The persona a chat is talking to, and the hidden agent a reminder made in that chat binds to until reminders
 * stop needing one. Schedules for a task bind to a saved agent instead.
 */
export interface ChatAssistant {
  persona: Pick<Persona, 'id' | 'display_name'> | null;
  /** The stored agent a reminder binds to. A plain chat's is made on first use, so call it only once approved. */
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

/** The assistant a chat's turn runs as right now, for a reminder made in that chat. */
export function resolveChatAssistant(input: {
  tenant_id: string;
  owner: CreatedBySubject;
  runner: ChatRunner;
  persona: Persona | undefined;
  agentStore: Pick<IAgentStore<unknown>, 'getAgent' | 'createAgent'>;
}): ChatAssistant {
  const { runner, persona } = input;
  const chatPersona = persona === undefined ? null : { id: persona.id, display_name: persona.display_name };
  if (runner.kind === 'saved') {
    return { persona: chatPersona, agent: () => Promise.resolve(runner.agent) };
  }
  const name = chatAssistantAgentName({ owner: input.owner, spec: runner.spec });
  return {
    persona: chatPersona,
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

/** Who a saved schedule runs as, in plain words: its persona, else its agent. */
export function scheduleRunsAs(input: {
  tenant_id: string;
  personaStore: Pick<IPersonaStore<unknown>, 'getPersona'>;
}): (schedule: ScheduleRecord) => Promise<string> {
  const { tenant_id } = input;
  const personas = new Map<string, Promise<Persona | undefined>>();
  return async schedule => {
    const { persona_id } = schedule;
    if (persona_id !== null) {
      const owner = schedule.created_by_subject.subject_id;
      const key = `${owner}\n${persona_id}`;
      const loading =
        personas.get(key) ?? input.personaStore.getPersona({ tenant_id, created_by: owner, id: persona_id });
      personas.set(key, loading);
      const persona = await loading;
      if (persona !== undefined) {
        return persona.display_name;
      }
    }
    return schedule.agent_name;
  };
}
