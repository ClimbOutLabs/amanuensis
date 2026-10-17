import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { GoogleApiError, GoogleOAuthError, GoogleReconnectRequiredError } from '../google/errors';
import type { GoogleFeature } from '../google/scopes';
import { errorResult, failureResult, jsonResult } from '../google/toolResults';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import type { ToolInvocationContext } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import { stampSentinelDecision } from '../mcp/ToolSet';
import { stableStringify } from '../permissions/approvalTokens';
import { classifyHostToolCall } from '../permissions/classifier';
import type { SentinelHostContext } from '../permissions/context';
import type { AgentTracing } from '../tracing/AgentTracing';
import { FALLBACK_TIMEZONE, isValidTimezone } from '../util/clientTimezone';
import { CalendarApi } from './CalendarApi';
import {
  hashEventWrite,
  resolveCreate,
  resolveUpdate,
  type CalendarWriteReview,
  type EventWriteRequest,
  type ResolvedEventWrite,
} from './eventWrite';
import { getEventResult, listEventsResult } from './results';
import { resolveBounds } from './timeRange';
import {
  CALENDAR_READ_ANNOTATIONS,
  CALENDAR_SERVER_ID,
  CALENDAR_WRITE_ANNOTATIONS,
  CREATE_EVENT_TOOL_NAME,
  CreateEventSchema,
  GET_EVENT_TOOL_NAME,
  GetEventSchema,
  isCalendarWriteToolName,
  LIST_EVENTS_TOOL_NAME,
  ListEventsSchema,
  UPDATE_EVENT_TOOL_NAME,
  UpdateEventSchema,
  type CreateEventInput,
  type UpdateEventInput,
} from './toolContract';

/** Keys the host adds to an approved write: the zone the times were read in, and the hash of what was shown. */
const APPROVED_ZONE_KEY = 'resolved_time_zone';
const REVIEW_HASH_KEY = 'review_hash';

const NO_ZONE =
  "Nothing was saved because Aman doesn't know which time zone the times are in. Ask the user, then pass time_zone.";

const NOT_APPROVED = 'This was not approved, so nothing was saved. Ask again to add or change the event.';

/** Said to the model when the user has Calendar but has not allowed writes, so it points them to Settings. */
const NO_WRITE_NOTE =
  ' Aman cannot add or change events yet: if asked to, tell the user to open Settings, Connectors, Google and select Allow Aman to add events.';

interface CalendarToolSetOptions {
  tracing: AgentTracing;
  api: CalendarApi;
  /** The connected address, named in every result. */
  account: string;
  /** Features Google actually granted: tools are offered only for these. */
  features: readonly GoogleFeature[];
  /** The user's IANA time zone (their device's, or a scheduled run's own); absent, the calendar's own zone is used. */
  timeZone: string | undefined;
  /** Where the host classifies each call; the same turn state the web search provider reads. */
  sentinel: SentinelHostContext;
}

/**
 * Google Calendar for one user's turn, over Calendar's REST API with that user's own login. Reads are silent;
 * adding or changing an event always asks, and nothing here deletes one.
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
    const { features } = this.#options;
    if (!features.includes('calendar_read')) {
      return [];
    }
    const canWrite = features.includes('calendar_write');
    return [
      defineTool({
        name: LIST_EVENTS_TOOL_NAME,
        description: `List events on the primary calendar in a time range, in start order, with repeating events unfolded into their dates. Dates (YYYY-MM-DD) are read in the user's time zone; a time_max date includes that whole day. Birthdays and other all-day events have all_day true and no clock time. Optional query searches title, description, place and guests.${canWrite ? '' : NO_WRITE_NOTE}`,
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
      // Offered in scheduled runs too: there a call is held for the owner's OK and never runs by itself.
      ...(canWrite
        ? [
            defineTool({
              name: CREATE_EVENT_TOOL_NAME,
              description:
                "Add an event to the user's primary Google Calendar. Use this, not a calendar file, when the user wants an event saved. Times are local wall-clock times (2026-10-19T09:00) in time_zone, or the user's own zone when it is left out; two dates make an all-day event. With attendees, send_updates must say whether Google emails them. The user sees the whole event and is asked first.",
              schema: CreateEventSchema,
              annotations: CALENDAR_WRITE_ANNOTATIONS,
              handler: (input, _approval, context) => this.#createEvent({ input, context }),
            }),
            defineTool({
              name: UPDATE_EVENT_TOOL_NAME,
              description:
                'Move or rename an event the user organizes, by event_id from list_events. Set only what changes; a new start alone keeps the length. If the event has guests, send_updates must say whether Google emails them. Guests cannot be changed and events cannot be deleted. The user sees before and after and is asked first.',
              schema: UpdateEventSchema,
              annotations: CALENDAR_WRITE_ANNOTATIONS,
              handler: (input, _approval, context) => this.#updateEvent({ input, context }),
            }),
          ]
        : []),
    ];
  }

  /**
   * The host classifies every call, so a tier and its card come from the classifier and never from this class.
   * A write's card is built from the request the host will really send, settled here from the validated call and,
   * for a change, the event as Google holds it now. Its hash and the zone it was read in join the approved call.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    const prepared = isCalendarWriteToolName(params.name) ? await this.#prepareWrite(params) : undefined;
    if (prepared !== undefined && 'failure' in prepared) {
      return { ...info, pre_dispatch_failure: { kind: 'policy_blocked', message: prepared.failure } };
    }
    const canonical = prepared?.approved ?? params.arguments ?? {};
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: canonical,
        tool_type: 'truefoundry-system',
        mcp_server_name: CALENDAR_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        ...(prepared === undefined ? {} : { calendar_write: prepared.review }),
      },
    });
    return {
      ...info,
      ...stampSentinelDecision({ decision }),
      ...(prepared === undefined ? {} : { mint_canonical_params: prepared.approved }),
    };
  }

  /**
   * Re-derives a write's approved params from the call as it reaches dispatch, reading the event again for a change,
   * so an approval ends when the arguments or the event changed after the card.
   */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (!isCalendarWriteToolName(params.name)) {
      return undefined;
    }
    const prepared = await this.#prepareWrite(params);
    if ('failure' in prepared) {
      throw new Error(prepared.failure);
    }
    return prepared.approved;
  }

  /** What a write call will do, for its card; a failure says why it cannot be shown and so is not offered. */
  async #prepareWrite(
    params: CallToolRequest['params'],
  ): Promise<{ approved: Record<string, unknown>; review: CalendarWriteReview } | { failure: string }> {
    try {
      const named = params.arguments?.['time_zone'];
      const zone = await this.#writeZone(named);
      if (zone === null) {
        return { failure: NO_ZONE };
      }
      // A held write is classified again when the owner approves it, on their device's zone; naming the zone
      // keeps the times the card shows.
      if (this.#options.sentinel.services.unattended && named === undefined) {
        return {
          failure: `Nothing was saved. In a scheduled run, pass time_zone (here it is ${zone}) so the event keeps its times when the owner approves it.`,
        };
      }
      const resolved = await this.#resolveWrite({ name: params.name, args: params.arguments ?? {}, zone });
      if (!resolved.ok) {
        return { failure: `Nothing was saved. ${resolved.error}` };
      }
      return {
        approved: {
          ...(params.arguments ?? {}),
          [APPROVED_ZONE_KEY]: zone,
          [REVIEW_HASH_KEY]: hashEventWrite(resolved.request),
        },
        review: resolved.review,
      };
    } catch (error) {
      if (
        error instanceof GoogleReconnectRequiredError ||
        error instanceof GoogleApiError ||
        error instanceof GoogleOAuthError
      ) {
        return { failure: `This could not be shown to you, so nothing was saved. ${error.message}` };
      }
      throw error;
    }
  }

  /** Settles one write from its arguments in a known zone; a change reads the event as Google holds it now. */
  async #resolveWrite(input: { name: string; args: unknown; zone: string }): Promise<ResolvedEventWrite> {
    const invalid: ResolvedEventWrite = { ok: false, error: 'The event details were not valid.' };
    if (input.name === CREATE_EVENT_TOOL_NAME) {
      const parsed = CreateEventSchema.safeParse(input.args);
      return parsed.success
        ? resolveCreate({ call: parsed.data, zone: input.zone, account: this.#options.account })
        : invalid;
    }
    const parsed = UpdateEventSchema.safeParse(input.args);
    if (!parsed.success) {
      return invalid;
    }
    const existing = await this.#options.api.getEvent({ eventId: parsed.data.event_id, timeZone: input.zone });
    return resolveUpdate({ call: parsed.data, zone: input.zone, account: this.#options.account, existing });
  }

  /** The user's own zone: the one this turn names when it is real, else the calendar's own. Null when neither is. */
  async #ownZone(): Promise<string | null> {
    const { timeZone } = this.#options;
    if (timeZone !== undefined && isValidTimezone(timeZone)) {
      return timeZone;
    }
    const calendarZone = await this.#options.api.calendarTimeZone();
    return calendarZone !== null && isValidTimezone(calendarZone) ? calendarZone : null;
  }

  /** A read with no known zone is shown in UTC and says so in its result. */
  async #zone(): Promise<string> {
    return (await this.#ownZone()) ?? FALLBACK_TIMEZONE;
  }

  /** A write is read in the zone the call names, else the user's own; never a guessed UTC. */
  async #writeZone(named: unknown): Promise<string | null> {
    return typeof named === 'string' && isValidTimezone(named) ? named : await this.#ownZone();
  }

  /**
   * The zone and hash the user approved this exact call under. A call that arrives without them, or with arguments
   * other than the approved ones, writes nothing; so does any call in a scheduled run, where nobody approved it.
   */
  #approvedWrite<T>(input: {
    call: T;
    schema: z.ZodType<T>;
    context: ToolInvocationContext | undefined;
  }): { zone: string; hash: string } | { refusal: string } {
    if (this.#options.sentinel.services.unattended) {
      return { refusal: "Scheduled runs never change the calendar. This waits for the owner's OK." };
    }
    const {
      [APPROVED_ZONE_KEY]: zone,
      [REVIEW_HASH_KEY]: hash,
      ...approvedArgs
    } = input.context?.approved_params ?? {};
    if (typeof zone !== 'string' || typeof hash !== 'string') {
      return { refusal: NOT_APPROVED };
    }
    const approved = input.schema.safeParse(approvedArgs);
    if (!approved.success || stableStringify(approved.data) !== stableStringify(input.call)) {
      return {
        refusal:
          'The event details changed after you approved them, so nothing was saved. Ask again to review the new details.',
      };
    }
    return { zone, hash };
  }

  /** Runs one approved write, only if what it would send now still hashes to what the card showed. */
  async #write(input: {
    approved: { zone: string; hash: string };
    resolve: (zone: string) => Promise<ResolvedEventWrite>;
    send: (request: EventWriteRequest) => Promise<{ id: string }>;
    status: 'created' | 'updated';
  }) {
    try {
      const resolved = await input.resolve(input.approved.zone);
      if (!resolved.ok) {
        return errorResult(`Nothing was saved. ${resolved.error}`);
      }
      if (hashEventWrite(resolved.request) !== input.approved.hash) {
        return errorResult(
          'The event changed after you approved this, so nothing was saved. Ask again to see it as it is now.',
        );
      }
      const saved = await input.send(resolved.request);
      return jsonResult({
        account: this.#options.account,
        event_id: saved.id,
        status: input.status,
        title: resolved.review.title,
        when: resolved.review.when,
        time_zone: resolved.review.time_zone,
        guests_emailed: resolved.review.guests_emailed,
      });
    } catch (error) {
      return failureResult(error);
    }
  }

  async #createEvent({ input, context }: { input: CreateEventInput; context: ToolInvocationContext | undefined }) {
    const approved = this.#approvedWrite({ call: input, schema: CreateEventSchema, context });
    if ('refusal' in approved) {
      return errorResult(approved.refusal);
    }
    return await this.#write({
      approved,
      resolve: zone => Promise.resolve(resolveCreate({ call: input, zone, account: this.#options.account })),
      send: request => this.#options.api.insertEvent(request),
      status: 'created',
    });
  }

  async #updateEvent({ input, context }: { input: UpdateEventInput; context: ToolInvocationContext | undefined }) {
    const approved = this.#approvedWrite({ call: input, schema: UpdateEventSchema, context });
    if ('refusal' in approved) {
      return errorResult(approved.refusal);
    }
    return await this.#write({
      approved,
      resolve: zone => this.#resolveWrite({ name: UPDATE_EVENT_TOOL_NAME, args: input, zone }),
      send: request => this.#options.api.patchEvent({ ...request, event_id: input.event_id }),
      status: 'updated',
    });
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
