import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ApprovalDecision } from '../../events/schema';
import type { InternalToolCallInfo } from '../../llm/LLMTypes';
import {
  type AgentToolSchema,
  type CallToolResponse,
  isAuthRequired,
  isCallToolResponseResult,
  type ListToolsResponse,
  type ToolInvocationContext,
  toolResultResponse,
  type ToolSource,
} from '../../mcp/IMCPServer';
import { accountNamesOfResult, emailsOfResult } from './mailToolResults';
import {
  MAIL_ACCOUNT_ARGUMENT,
  MAIL_ACCOUNT_LIST_TOOL_NAME,
  MAIL_CONNECTOR_TOOL_NAMES,
  MAIL_LIST_TOOL_NAME,
} from './toolContract';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A list call with no date looks this far back first, then once more over the wider window. */
const RECENT_WINDOW_DAYS = 7;
const WIDER_WINDOW_DAYS = 30;
/** The sidecar's own page size when the call leaves it out. */
const SIDECAR_DEFAULT_PAGE_SIZE = 10;
/** Chats whose account list is kept; the oldest is dropped first. */
const MAX_CACHED_CHATS = 1000;

const ACCOUNTS_UNREADABLE =
  'The list of Email accounts could not be read, so nothing was done. Try again in a minute, and tell the person if it keeps failing.';
const ACCOUNT_NOTE = 'Leave it out when there is one account; it is filled in for you.';
const RECENT_WINDOW_NOTE = `With no since or before date, this looks at the last ${String(RECENT_WINDOW_DAYS)} days, then the last ${String(WIDER_WINDOW_DAYS)} if fewer messages than asked for come back. Results are newest first within that window. Set since to look further back.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMailConnectorTool(name: string): boolean {
  return MAIL_CONNECTOR_TOOL_NAMES.some(tool => tool === name);
}

/** Has no date bound, so the sidecar would scan the whole mailbox. */
function hasNoDateBound(args: Record<string, unknown>): boolean {
  return args['since'] === undefined && args['before'] === undefined;
}

/**
 * The account name is never required of the model, and list calls say how they pick recent mail. Built from
 * the listed schema alone, so the tool list stays the same on every call.
 */
function withHostFilledAccount(tool: AgentToolSchema): AgentToolSchema {
  if (!isMailConnectorTool(tool.name)) {
    return tool;
  }
  const { properties, required } = tool.inputSchema;
  const account = properties?.[MAIL_ACCOUNT_ARGUMENT];
  const description =
    tool.name === MAIL_LIST_TOOL_NAME ? `${tool.description ?? ''} ${RECENT_WINDOW_NOTE}`.trim() : tool.description;
  if (properties === undefined || !isRecord(account)) {
    return { ...tool, description };
  }
  const accountDescription = typeof account['description'] === 'string' ? `${account['description']} ` : '';
  return {
    ...tool,
    description,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        [MAIL_ACCOUNT_ARGUMENT]: { ...account, description: `${accountDescription}${ACCOUNT_NOTE}` },
      },
      ...(required === undefined ? {} : { required: required.filter(name => name !== MAIL_ACCOUNT_ARGUMENT) }),
    },
  };
}

function refusal(text: string): CallToolResponse {
  return toolResultResponse({ text: JSON.stringify({ error: text }), isError: true });
}

/** Keeps each chat's Email account names, read once. A failed read is not kept, so the next call reads again. */
export class MailAccountDirectory {
  readonly #byChat = new Map<string, Promise<readonly string[]>>();

  accounts({ chat_id, read }: { chat_id: string; read: () => Promise<readonly string[]> }): Promise<readonly string[]> {
    const cached = this.#byChat.get(chat_id);
    if (cached !== undefined) {
      return cached;
    }
    const made = read();
    this.#byChat.set(chat_id, made);
    made.catch(() => {
      if (this.#byChat.get(chat_id) === made) {
        this.#byChat.delete(chat_id);
      }
    });
    const [oldest] = this.#byChat.keys();
    if (this.#byChat.size > MAX_CACHED_CHATS && oldest !== undefined) {
      this.#byChat.delete(oldest);
    }
    return made;
  }
}

/** Reads the sidecar's account names. Throws when the list cannot be read or names no account. */
export async function readMailAccountNames(source: Pick<ToolSource, 'callTool'>): Promise<readonly string[]> {
  const response = await source.callTool({ name: MAIL_ACCOUNT_LIST_TOOL_NAME, arguments: {} });
  if (!isCallToolResponseResult(response) || response.result.isError === true) {
    throw new Error('The Email sidecar did not return its account list.');
  }
  const names = accountNamesOfResult(response.result);
  if (names.length === 0) {
    throw new Error('The Email sidecar listed no account.');
  }
  return names;
}

/**
 * The Email connector as the model sees it. The host fills in the account name, so the model never has to
 * know it, and a list call with no date only looks at recent mail, so it never scans the whole mailbox.
 */
export class MailConnectorSource implements ToolSource {
  readonly #inner: ToolSource;
  readonly #accounts: () => Promise<readonly string[]>;
  readonly #now: () => Date;

  constructor({
    inner,
    accounts,
    now,
  }: {
    inner: ToolSource;
    accounts: () => Promise<readonly string[]>;
    now: () => Date;
  }) {
    this.#inner = inner;
    this.#accounts = accounts;
    this.#now = now;
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

  async listTools(): Promise<ListToolsResponse> {
    const listed = await this.#inner.listTools();
    if (isAuthRequired(listed)) {
      return listed;
    }
    return { ...listed, result: { tools: listed.result.tools.map(withHostFilledAccount) } };
  }

  toolCallInfo(params: CallToolRequest['params'], resolveUnderlyingTool?: boolean): Promise<InternalToolCallInfo> {
    return this.#inner.toolCallInfo(params, resolveUnderlyingTool);
  }

  async callTool(
    params: CallToolRequest['params'],
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    if (!isMailConnectorTool(params.name)) {
      return this.#inner.callTool(params, approvalDecision, context);
    }
    const given = params.arguments ?? {};
    const account = await this.#accountFor(given[MAIL_ACCOUNT_ARGUMENT]);
    if ('refused' in account) {
      return refusal(account.refused);
    }
    const args: Record<string, unknown> = { ...given, [MAIL_ACCOUNT_ARGUMENT]: account.name };
    const send = (sent: Record<string, unknown>) =>
      this.#inner.callTool({ ...params, arguments: sent }, approvalDecision, context);
    if (params.name !== MAIL_LIST_TOOL_NAME || !hasNoDateBound(args)) {
      return send(args);
    }
    const wanted = typeof args['page_size'] === 'number' ? args['page_size'] : SIDECAR_DEFAULT_PAGE_SIZE;
    const recent = { order: 'desc', ...args };
    const first = await send({ ...recent, since: this.#daysAgo(RECENT_WINDOW_DAYS) });
    if (!isCallToolResponseResult(first) || first.result.isError === true) {
      return first;
    }
    if (emailsOfResult(first.result).length >= wanted) {
      return first;
    }
    return send({ ...recent, since: this.#daysAgo(WIDER_WINDOW_DAYS) });
  }

  #daysAgo(days: number): string {
    return new Date(this.#now().getTime() - days * DAY_MS).toISOString();
  }

  /** The account the call goes to. With one account it is always that one; with several the name must match. */
  async #accountFor(requested: unknown): Promise<{ name: string } | { refused: string }> {
    let names: readonly string[];
    try {
      names = await this.#accounts();
    } catch {
      return { refused: ACCOUNTS_UNREADABLE };
    }
    const [only, ...others] = names;
    if (only === undefined) {
      return { refused: ACCOUNTS_UNREADABLE };
    }
    if (typeof requested === 'string' && names.includes(requested)) {
      return { name: requested };
    }
    if (others.length === 0) {
      return { name: only };
    }
    const listed = names.map(name => `'${name}'`).join(', ');
    return {
      refused:
        typeof requested === 'string'
          ? `There is no Email account named '${requested}'. The accounts are ${listed}; use one of these names.`
          : `Say which Email account to use. The accounts are ${listed}.`,
    };
  }
}
