import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** What a schedule runs with. `saved_agent`: the tools are set on the agent named in `agentName`. */
export interface ScheduleTools {
  source: 'schedule' | 'saved_agent';
  agentName: string;
  connectors: string[];
  skills: string[];
  sandboxEnabled: boolean;
}

export type ScheduleToolsChange = Pick<ScheduleTools, 'connectors' | 'skills' | 'sandboxEnabled'>;

export interface ScheduleToolsCatalog {
  getScheduleTools(scheduleId: string): Promise<ScheduleTools>;
  setScheduleTools(input: { scheduleId: string; tools: ScheduleToolsChange }): Promise<ScheduleTools>;
}

const ScheduleToolsResponseSchema = z.object({
  data: z.object({
    source: z.enum(['schedule', 'saved_agent']),
    agent_name: z.string(),
    connectors: z.array(z.string()),
    skills: z.array(z.string()),
    sandbox_enabled: z.boolean(),
  }),
});

function parseTools(body: unknown): ScheduleTools {
  const parsed = ScheduleToolsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server sent back tools in a form this page does not know. Reload the page and try again.');
  }
  const { data } = parsed.data;
  return {
    source: data.source,
    agentName: data.agent_name,
    connectors: data.connectors,
    skills: data.skills,
    sandboxEnabled: data.sandbox_enabled,
  };
}

/**
 * Calls GET/PUT /api/v1/schedules/{id}/tools with the same base URL, token and fetch the SDK client was built
 * from. Direct rather than through the client because the generated SDK does not carry this route yet; it moves
 * onto the client at the next regeneration.
 */
export function createScheduleToolsCatalog(options: CreateTrueForgeClientOptions = {}): ScheduleToolsCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(input: {
    method: 'GET' | 'PUT';
    scheduleId: string;
    body?: { connectors: string[]; skills: string[]; sandbox_enabled: boolean };
  }): Promise<ScheduleTools> {
    const response = await fetchImpl(`${base}/api/v1/schedules/${encodeURIComponent(input.scheduleId)}/tools`, {
      method: input.method,
      headers: {
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        failure.success
          ? failure.data.error.message
          : `The tools could not be loaded or saved (error ${String(response.status)}). Try again in a moment.`,
      );
    }
    return parseTools(responseBody);
  }

  return {
    getScheduleTools: scheduleId => request({ method: 'GET', scheduleId }),
    setScheduleTools: ({ scheduleId, tools }) =>
      request({
        method: 'PUT',
        scheduleId,
        body: { connectors: tools.connectors, skills: tools.skills, sandbox_enabled: tools.sandboxEnabled },
      }),
  };
}

/** Human-readable error for the Tools section; callers render it inline. */
export function scheduleToolsErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The tools could not be saved. Try again in a moment.');
}
