import { z } from 'zod';
import { type CallToolResponse, toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { AgentTracing } from '../../tracing/AgentTracing';
import { resolveLocalTime } from '../../util/clientTimezone';
import type { AgentCapability } from '../AgentCapability';

export const CURRENT_DATETIME_SERVER_ID = 'current-datetime';
export const GET_CURRENT_DATETIME_TOOL_NAME = 'get_current_datetime';

const inputSchema = z.object({}).strict();

export class CurrentDateTime extends LocalToolMCP {
  readonly name = CURRENT_DATETIME_SERVER_ID;
  readonly displayName = 'CurrentDateTime';

  /** IANA zone name from the client (AgentDefinition.clientTimezone); undefined falls back to UTC. */
  #timezone: string | undefined;

  constructor(tracing: AgentTracing, timezone?: string) {
    super({ tracing });
    this.#timezone = timezone;
  }

  private tools: ToolDefinition[] = [
    defineTool({
      name: GET_CURRENT_DATETIME_TOOL_NAME,
      description:
        'Returns the current datetime. Reports the local date, time, IANA zone and UTC offset when the ' +
        "client's timezone is known, and always also reports UTC in ISO-8601 and unix epoch MS format.",
      schema: inputSchema,
      handler: () => Promise.resolve(this.getCurrentDateTime()),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  // Date.prototype.toISOString() is spec-guaranteed to return UTC (suffix 'Z').
  // Date.prototype.getTime() returns UTC epoch ms regardless of process timezone.
  private getCurrentDateTime(): CallToolResponse {
    const now = new Date();
    const local = resolveLocalTime(now, this.#timezone);
    const payload = {
      // Local time first: this is what a user asking "what time is it" means. Falls back to UTC
      // (isFallback: true) when the client did not send a timezone.
      local: {
        date: local.date,
        time: local.time,
        zone: local.zone,
        utcOffset: local.utcOffset,
        isFallback: local.isFallback,
      },
      utc: {
        iso: now.toISOString(),
        unixEpochMS: now.getTime(),
      },
    };
    return toolResultResponse({ text: JSON.stringify(payload) });
  }
}

export function currentDateTime(options: { tracing: AgentTracing; timezone?: string | undefined }): AgentCapability {
  return {
    systemToolSets: [new CurrentDateTime(options.tracing, options.timezone)],
  };
}
