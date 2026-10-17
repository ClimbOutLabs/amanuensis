import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { GoogleFeature } from '../google/scopes';
import { errorResult, failureResult, jsonResult } from '../google/toolResults';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import { stampSentinelDecision } from '../mcp/ToolSet';
import { classifyHostToolCall } from '../permissions/classifier';
import type { SentinelHostContext } from '../permissions/context';
import type { AgentTracing } from '../tracing/AgentTracing';
import { FALLBACK_TIMEZONE, isValidTimezone } from '../util/clientTimezone';
import { CalendarApi } from './CalendarApi';
import { getEventResult, listEventsResult } from './results';
import { resolveBounds } from './timeRange';
import {
  CALENDAR_READ_ANNOTATIONS,
  CALENDAR_SERVER_ID,
  GET_EVENT_TOOL_NAME,
  GetEventSchema,
  LIST_EVENTS_TOOL_NAME,
  ListEventsSchema,
} from './toolContract';

interface CalendarToolSetOptions {
  tracing: AgentTracing;
  api: CalendarApi;
  /** The connected address, named in every result. */
  account: string;
  /** Features Google actually granted: tools are offered only for these. */
  features: readonly GoogleFeature[];
  /** The user's IANA time zone from their device; absent, the calendar's own zone is used. */
  timeZone: string | undefined;
  /** Where the host classifies each call; the same turn state the web search provider reads. */
  sentinel: SentinelHostContext;
}

/**
 * Google Calendar for one user's turn, over Calendar's REST API with that user's own login. Read-only: there
 * is nothing here that creates, changes or deletes an event.
 */
export class CalendarToolSet extends LocalToolMCP {
  readonly name = CALENDAR_SERVER_ID;
  readonly displayName = 'Google Calendar';
  readonly #options: CalendarToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: CalendarToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = this.#buildTools();
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  #buildTools(): ToolDefinition[] {
    if (!this.#options.features.includes('calendar_read')) {
      return [];
    }
    return [
      defineTool({
        name: LIST_EVENTS_TOOL_NAME,
        description:
          "List events on the primary calendar in a time range, in start order, with repeating events unfolded into their dates. Dates (YYYY-MM-DD) are read in the user's time zone; a time_max date includes that whole day. Birthdays and other all-day events have all_day true and no clock time. Optional query searches title, description, place and guests.",
        schema: ListEventsSchema,
        annotations: CALENDAR_READ_ANNOTATIONS,
        handler: input => this.#listEvents(input),
      }),
      defineTool({
        name: GET_EVENT_TOOL_NAME,
        description: 'Read one event in full by event_id: description, place, guests and how it repeats.',
        schema: GetEventSchema,
        annotations: CALENDAR_READ_ANNOTATIONS,
        handler: input => this.#getEvent(input),
      }),
    ];
  }

  /** The host classifies every call, so a tier comes from the classifier and never from this class. */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: params.arguments ?? {},
        tool_type: 'truefoundry-system',
        mcp_server_name: CALENDAR_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
      },
    });
    return { ...info, ...stampSentinelDecision({ decision }) };
  }

  /** The user's zone when their device named a real one, else the calendar's own, else UTC. */
  async #zone(): Promise<string> {
    const { timeZone } = this.#options;
    if (timeZone !== undefined && isValidTimezone(timeZone)) {
      return timeZone;
    }
    const calendarZone = await this.#options.api.calendarTimeZone();
    return calendarZone !== null && isValidTimezone(calendarZone) ? calendarZone : FALLBACK_TIMEZONE;
  }

  async #listEvents(input: z.infer<typeof ListEventsSchema>) {
    try {
      const zone = await this.#zone();
      const bounds = resolveBounds({ time_min: input.time_min, time_max: input.time_max, zone });
      if (!bounds.ok) {
        return errorResult(bounds.error);
      }
      const page = await this.#options.api.listEvents({
        timeMin: bounds.timeMin,
        timeMax: bounds.timeMax,
        query: input.query,
        maxResults: input.max_results,
        pageToken: input.page_token,
        timeZone: zone,
      });
      return jsonResult(
        listEventsResult({
          context: { account: this.#options.account, zone },
          events: page.events,
          nextPageToken: page.nextPageToken,
        }),
      );
    } catch (error) {
      return failureResult(error);
    }
  }

  async #getEvent(input: z.infer<typeof GetEventSchema>) {
    try {
      const zone = await this.#zone();
      const event = await this.#options.api.getEvent({ eventId: input.event_id, timeZone: zone });
      return jsonResult(getEventResult({ context: { account: this.#options.account, zone }, event }));
    } catch (error) {
      return failureResult(error);
    }
  }
}
