/**
 * The `usage_summary` built-in: a read-only tool that tells the person what their own chats have
 * used and cost. It reads only sessions the person created, and the shared daily cap.
 */
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session/store/ISessionStore';
import {
  defineTool,
  LocalToolMCP,
  toolResultResponse,
  type AgentCapability,
  type AgentTracing,
  type CallToolResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { MODEL_USAGE_EVENT_TYPE } from '../schemas/modelUsageEvents';
import type { TokenFactoryBudget } from './tokenFactoryBudget';
import {
  resolveUsagePeriod,
  summarizeUsage,
  USAGE_SUMMARY_INPUT_SCHEMA,
  UsagePeriodError,
  type UsageEntry,
  type UsagePeriod,
  type UsageSummaryInput,
} from './usageSummary';

export const USAGE_SUMMARY_SERVER_ID = 'usage';
export const USAGE_SUMMARY_TOOL_NAME = 'usage_summary';

const SESSION_PAGE_SIZE = 100;
const EVENT_PAGE_SIZE = 100;

/** The two reads the usage tool makes; any session store satisfies them. */
export type UsageSessionReader = Pick<ISessionStore<SessionCustom, TurnCustom>, 'listSessions' | 'listSessionEvents'>;

/**
 * Every usage entry the person's own chats recorded in `[from, to)`. Sessions are read by creator,
 * so another person's chats never enter the walk, and each event is kept only by its own time.
 */
export async function collectUsageEntries({
  sessionStore,
  tenantId,
  userRef,
  from,
  to,
}: {
  sessionStore: UsageSessionReader;
  tenantId: string;
  userRef: string;
  from: Date;
  to: Date;
}): Promise<UsageEntry[]> {
  const entries: UsageEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = await sessionStore.listSessions({
      tenant_id: tenantId,
      limit: SESSION_PAGE_SIZE,
      page_token: pageToken,
      order: 'desc',
      start_timestamp: undefined,
      end_timestamp: undefined,
      agent_id: undefined,
      created_by_or_agent_ids: { created_by_subject_id: userRef, agent_ids: [] },
      metadata: undefined,
      source_type: undefined,
      source_id: undefined,
    });
    for (const session of page.data) {
      if (session.created_by_subject.subject_id !== userRef) {
        continue;
      }
      entries.push(
        ...(await usageEntriesForSession({
          sessionStore,
          sessionId: session.session_id,
          title: session.title,
          from,
          to,
        })),
      );
    }
    pageToken = page.pagination.next_page_token;
  } while (pageToken !== undefined);
  return entries;
}

async function usageEntriesForSession({
  sessionStore,
  sessionId,
  title,
  from,
  to,
}: {
  sessionStore: UsageSessionReader;
  sessionId: string;
  title: string | null;
  from: Date;
  to: Date;
}): Promise<UsageEntry[]> {
  const entries: UsageEntry[] = [];
  let pageToken: string | undefined;
  do {
    const page = await sessionStore.listSessionEvents({
      session_id: sessionId,
      limit: EVENT_PAGE_SIZE,
      page_token: pageToken,
      last_turn_id: undefined,
      types: [MODEL_USAGE_EVENT_TYPE],
      after_event_id: undefined,
    });
    for (const { event } of page.data) {
      if (event.type !== MODEL_USAGE_EVENT_TYPE) {
        continue;
      }
      const createdAt = new Date(event.created_at);
      if (createdAt < from || createdAt >= to) {
        continue;
      }
      entries.push({
        session_id: sessionId,
        title,
        model_id: event.model_id,
        display_name: event.display_name,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cost_usd: event.cost_usd,
        created_at: event.created_at,
      });
    }
    pageToken = page.pagination.next_page_token;
  } while (pageToken !== undefined);
  return entries;
}

const USAGE_SUMMARY_DESCRIPTION =
  "Read the signed-in person's own usage: tokens in and out, cost where the price is known, split by model and by day, the top chats by cost (titles only), and the shared daily Token Factory cap left. Use it for questions about what their chats cost or how much they used. Periods: today, this_week, this_month (default), or date_range. Tokens with no known price are counted apart: say so, never guess a price. Answer in a few plain sentences with the figures; a small bar chart fits when there are several days or models.";

export interface UsageSummaryTurnContext {
  sessionStore: UsageSessionReader;
  budget: TokenFactoryBudget;
  authority: { tenantId: string; userRef: string };
}

export interface UsageSummaryCapabilityOptions extends UsageSummaryTurnContext {
  tracing: AgentTracing;
  /** IANA zone name from the client; undefined means UTC. */
  timeZone: string | undefined;
  now?: () => Date;
}

class UsageSummaryTool extends LocalToolMCP {
  readonly name = USAGE_SUMMARY_SERVER_ID;
  readonly displayName = 'Usage';

  constructor(private readonly options: UsageSummaryCapabilityOptions) {
    super({ tracing: options.tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: USAGE_SUMMARY_TOOL_NAME,
      description: USAGE_SUMMARY_DESCRIPTION,
      schema: USAGE_SUMMARY_INPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: input => this.summarize(input),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async summarize(input: UsageSummaryInput): Promise<CallToolResponse> {
    const { sessionStore, budget, authority } = this.options;
    let period: UsagePeriod;
    try {
      period = resolveUsagePeriod({
        input,
        now: this.options.now?.() ?? new Date(),
        timeZone: this.options.timeZone,
      });
    } catch (error) {
      if (error instanceof UsagePeriodError) {
        return toolResultResponse({ text: error.message, isError: true });
      }
      throw error;
    }
    const entries = await collectUsageEntries({
      sessionStore,
      tenantId: authority.tenantId,
      userRef: authority.userRef,
      from: period.from,
      to: period.to,
    });
    const day = await budget.today();
    const summary = summarizeUsage({
      entries,
      period,
      cap: day.cap_tokens === undefined ? undefined : { capTokens: day.cap_tokens, usedTokens: day.used_tokens },
    });
    return toolResultResponse({ text: JSON.stringify(summary) });
  }

  // A read of the person's own numbers: it gets no approval prompt, like the space reads.
  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    return {
      ...info,
      effect: 'inspect',
      read_only_hint: true,
      destructive_hint: false,
      open_world_hint: false,
    };
  }
}

export function usageSummaryCapability(options: UsageSummaryCapabilityOptions): AgentCapability {
  return { systemToolSets: [new UsageSummaryTool(options)] };
}
