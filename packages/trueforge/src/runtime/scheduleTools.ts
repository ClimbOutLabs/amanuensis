import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import { HTTPException } from 'hono/http-exception';
import type { AgentRecord } from '../db/agentStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ScheduleRecord } from '../db/scheduleStore';
import type { ISkillStore } from '../db/skillStore';
import type { ScheduleTools, UpdateScheduleToolsRequest } from '../schemas/schedule';
import { isChatAssistantAgent, type ScheduleAgentChoices } from './chatAssistant';
import { validateAgentSpec } from './sessionResources';

/** The tools a schedule runs with, read from the agent it is bound to. */
export function scheduleToolsOf({ schedule, agent }: { schedule: ScheduleRecord; agent: AgentRecord }): ScheduleTools {
  const spec = agent.manifest;
  return {
    // Only the agent the host made for this person's schedules is theirs to change; a saved agent is shared.
    source: isChatAssistantAgent({ agent, owner: schedule.created_by_subject }) ? 'schedule' : 'saved_agent',
    agent_name: agent.name,
    connectors: (spec.mcp_servers ?? []).map(server => server.name),
    skills: (spec.skills ?? []).map(skill => skill.name),
    sandbox_enabled: spec.config.sandbox.enabled,
  };
}

/**
 * The agent's spec with only the connectors, skills and sandbox swapped. Connectors and skills that stay keep
 * their own settings, so the rest of what the chat set up carries over unchanged.
 */
export function specWithTools({
  spec,
  tools,
}: {
  spec: AgentSpec;
  tools: UpdateScheduleToolsRequest;
}): { ok: true; spec: AgentSpec } | { ok: false; message: string } {
  const connectors = tools.connectors.map(name => spec.mcp_servers?.find(server => server.name === name) ?? { name });
  const skills = tools.skills.map(name => spec.skills?.find(skill => skill.name === name) ?? { name });
  const parsed = AgentSpecSchema.safeParse({
    ...spec,
    mcp_servers: connectors,
    skills,
    config: { ...spec.config, sandbox: { ...spec.config.sandbox, enabled: tools.sandbox_enabled } },
  });
  if (!parsed.success) {
    return { ok: false, message: 'These tools could not be saved. Check the connectors and skills, then try again.' };
  }
  return { ok: true, spec: parsed.data };
}

/** The connectors and skills a person may give a schedule made in a chat, and the check any saved agent passes. */
export function scheduleAgentChoices(input: {
  tenant_id: string;
  modelProviderStore: IModelProviderStore;
  mcpServerStore: IMcpServerStore;
  skillStore: ISkillStore;
  sandboxProviderStore: ISandboxProviderStore;
  searchProviderPresetNames: readonly string[];
}): ScheduleAgentChoices {
  const { tenant_id } = input;
  return {
    available: async () => {
      const [servers, skills] = await Promise.all([
        input.mcpServerStore.listServers({ tenant_id, names: undefined }),
        input.skillStore.listSkills({ tenant_id, names: undefined }),
      ]);
      return {
        connectors: servers.map(server => server.name),
        skills: skills.map(skill => skill.name),
      };
    },
    problemWith: async spec => {
      try {
        await validateAgentSpec({ ...input, spec });
        return null;
      } catch (error) {
        if (error instanceof HTTPException && error.status === 422) {
          return error.message;
        }
        throw error;
      }
    },
  };
}
