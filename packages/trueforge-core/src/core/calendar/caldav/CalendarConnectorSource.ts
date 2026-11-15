import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalDecision } from '../../events/schema';
import type { InternalToolCallInfo } from '../../llm/LLMTypes';
import {
  type CallToolResponse,
  type ListToolsResponse,
  type ToolInvocationContext,
  toolResultResponse,
  type ToolSource,
} from '../../mcp/IMCPServer';
import { isCaldavReadToolName, isCaldavToolName } from './toolContract';

/**
 * The accounts a chat can see, as the host reads them: every connected account's address, the
 * default among them, and the accounts the persona is limited to (null when it may use all).
 */
export interface CalendarAccountSnapshot {
  names: readonly string[];
  default_name: string | null;
  allowed: readonly string[] | null;
}

/** The host argument that scopes a spanning read to the accounts a persona may use. Never advertised. */
export const CALENDAR_LIMIT_ARGUMENT = 'limit_accounts';

const ID_KEYS = ['calendar_id', 'destination_calendar_id', 'id'] as const;

function refusal(text: string): CallToolResponse {
  return toolResultResponse({ text: JSON.stringify({ error: text }), isError: true });
}

/** The account an id names, or null when the id carries no known account prefix. */
function accountOfId(id: unknown, names: readonly string[]): string | null {
  if (typeof id !== 'string') {
    return null;
  }
  const cut = id.indexOf('|');
  if (cut <= 0) {
    return null;
  }
  const head = id.slice(0, cut);
  return names.includes(head) ? head : null;
}

/** Every connected account a call names, through its account argument and the ids it carries. */
function namedAccounts(args: Record<string, unknown>, names: readonly string[]): ReadonlySet<string> {
  const named = new Set<string>();
  if (typeof args['account'] === 'string' && names.includes(args['account'])) {
    named.add(args['account']);
  }
  for (const key of ID_KEYS) {
    const account = accountOfId(args[key], names);
    if (account !== null) {
      named.add(account);
    }
  }
  if (Array.isArray(args['calendars'])) {
    for (const ref of args['calendars']) {
      const account = accountOfId(ref, names);
      if (account !== null) {
        named.add(account);
      }
    }
  }
  return named;
}

/**
 * The Calendar connector's account guard, wrapped around the sidecar's multiplexer. The multiplexer
 * routes a call by the account its ids name; this wrapper keeps a persona inside the accounts it is
 * allowed to use. A call naming an account outside the limit is refused here and never reaches the
 * sidecar, and a spanning read is scoped to the accounts the persona may use. An approval replays
 * the call it was given on, ids and all, so it keeps acting on the same account.
 */
export class CalendarConnectorSource implements ToolSource {
  readonly #inner: ToolSource;
  readonly #accounts: () => Promise<CalendarAccountSnapshot>;

  constructor({ inner, accounts }: { inner: ToolSource; accounts: () => Promise<CalendarAccountSnapshot> }) {
    this.#inner = inner;
    this.#accounts = accounts;
  }

  get name(): string {
    return this.#inner.name;
  }

  get id(): string {
    return this.#inner.id;
  }

  get description(): string | undefined {
    return this.#inner.description;
  }

  get serverHost(): string | undefined {
    return this.#inner.serverHost;
  }

  listTools(): Promise<ListToolsResponse> {
    return this.#inner.listTools();
  }

  toolCallInfo(params: CallToolRequest['params'], resolveUnderlyingTool?: boolean): Promise<InternalToolCallInfo> {
    return this.#inner.toolCallInfo(params, resolveUnderlyingTool);
  }

  async callTool(
    params: CallToolRequest['params'],
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    if (!isCaldavToolName(params.name)) {
      return this.#inner.callTool(params, approvalDecision, context);
    }
    const snapshot = await this.#accounts();
    if (snapshot.names.length === 0) {
      return this.#inner.callTool(params, approvalDecision, context);
    }
    const usable =
      snapshot.allowed === null
        ? [...snapshot.names]
        : snapshot.names.filter(name => snapshot.allowed?.includes(name) === true);
    if (usable.length === 0) {
      return refusal('This persona cannot use any of the connected Calendar accounts, so nothing was done.');
    }
    const args: Record<string, unknown> = params.arguments ?? {};
    const named = namedAccounts(args, snapshot.names);
    for (const account of named) {
      if (!usable.includes(account)) {
        return refusal(
          `This persona cannot use the Calendar account '${account}'. The accounts it can use are ${usable.join(', ')}.`,
        );
      }
    }
    if (named.size > 0 || !isCaldavReadToolName(params.name)) {
      return this.#inner.callTool(params, approvalDecision, context);
    }
    // A read that names no account spans every account at the multiplexer. Scope it to the accounts
    // this persona may use: the one usable account is named outright, and a wider limit travels as
    // the host's own scoping argument, which the multiplexer honours and never forwards.
    if (usable.length === 1) {
      return this.#inner.callTool({ ...params, arguments: { ...args, account: usable[0] } }, approvalDecision, context);
    }
    if (usable.length < snapshot.names.length) {
      return this.#inner.callTool(
        { ...params, arguments: { ...args, [CALENDAR_LIMIT_ARGUMENT]: usable } },
        approvalDecision,
        context,
      );
    }
    return this.#inner.callTool(params, approvalDecision, context);
  }
}
