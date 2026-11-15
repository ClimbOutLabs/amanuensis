import { z } from 'zod';
import { type CallToolResponse, toolResultResponse } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import type { AgentTracing } from '../../tracing/AgentTracing';
import { weekdayNameOf } from '../../util/calendarDay';
import { resolveLocalTime } from '../../util/clientTimezone';
import type { AgentCapability } from '../AgentCapability';

export const CURRENT_DATETIME_SERVER_ID = 'current-datetime';
export const GET_CURRENT_DATETIME_TOOL_NAME = 'get_current_datetime';

const inputSchema = z.object({}).strict();

export class CurrentDateTime extends LocalToolMCP {
  readonly name = CURRENT_DATETIME_SERVER_ID;
  readonly displayName = 'CurrentDateTime';

  /** The person's IANA zone (AgentDefinition.clientTimezone); undefined falls back to UTC. */
  #timezone: string | undefined;

  constructor(tracing: AgentTracing, timezone?: string) {
    super({ tracing });
    this.#timezone = timezone;
  }

  private tools: ToolDefinition[] = [
    defineTool({
      name: GET_CURRENT_DATETIME_TOOL_NAME,
      description:
        "Returns the current date, weekday and time in the person's own time zone, with the IANA zone and its UTC " +
        'offset. When their zone is not known the answer is in UTC and says so. Also reports unix epoch MS.',
      schema: inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: () => Promise.resolve(this.getCurrentDateTime()),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  // Date.prototype.getTime() returns UTC epoch ms regardless of process timezone.
  private getCurrentDateTime(): CallToolResponse {
    const now = new Date();
    const local = resolveLocalTime(now, this.#timezone);
    // One date and one time only. A second, UTC, date next to the person's own is read as today from late
    // afternoon in the Americas, when the UTC day is already tomorrow. The offset still fixes the instant.
    const payload = {
      date: local.date,
      // Stated so the model never has to work out the day of the week itself.
      weekday: weekdayNameOf(local.date),
      time: local.time,
      zone: local.zone,
      utcOffset: local.utcOffset,
      // False when no zone is known for the person, so the date and time above are UTC and not their own.
      zoneIsThePersons: !local.isFallback,
      unixEpochMS: now.getTime(),
    };
    return toolResultResponse({ text: JSON.stringify(payload) });
  }
}

export function currentDateTime(options: { tracing: AgentTracing; timezone?: string | undefined }): AgentCapability {
  return {
    systemToolSets: [new CurrentDateTime(options.tracing, options.timezone)],
  };
}
