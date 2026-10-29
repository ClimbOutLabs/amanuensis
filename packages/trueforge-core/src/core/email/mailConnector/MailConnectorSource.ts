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
import { isRecord } from '../../util/records';
import { accountNamesOfResult, emailsOfResult } from './mailToolResults';
import { isRecipientRefusal, RECIPIENT_NOT_LISTED } from './recipientRefusal';
import {
  isMailComposeToolName,
  isMailReadToolName,
  MAIL_ACCOUNT_ARGUMENT,
  MAIL_ACCOUNT_LIST_TOOL_NAME,
  MAIL_CONNECTOR_TOOL_NAMES,
  MAIL_DRAFT_TOOL_NAME,
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
const DRAFT_RECIPIENT_NOTE =
  'Recipients the person named must stay on the call: a recipient who is not on the Email list is handled by an approval card shown to the person, and a draft with no recipient is refused. Never leave recipients off to get past a refusal.';
const RECENT_WINDOW_NOTE = `With no since date, this looks at the ${String(RECENT_WINDOW_DAYS)} days up to before (or up to now), then ${String(WIDER_WINDOW_DAYS)} days if fewer messages than asked for come back. Results are newest first within that window. Set since to look further back.`;

function isMailConnectorTool(name: string): boolean {
  return MAIL_CONNECTOR_TOOL_NAMES.some(tool => tool === name);
}

/** A null date means no date, so it is left out rather than sent on. */
function withoutNullDates(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([key, value]) => !((key === 'since' || key === 'before') && value === null)),
  );
}

/** Whether the account name was left out. A null name counts as left out. */
function isAccountLeftOut(requested: unknown): requested is undefined | null {
  return requested === undefined || requested === null;
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
    tool.name === MAIL_LIST_TOOL_NAME
      ? `${tool.description ?? ''} ${RECENT_WINDOW_NOTE}`.trim()
      : tool.name === MAIL_DRAFT_TOOL_NAME
        ? `${tool.description ?? ''} ${DRAFT_RECIPIENT_NOTE}`.trim()
        : tool.description;
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

/** The sidecar's raw recipient refusal, in whichever text block it arrived, becomes the plain stop. */
function plainRecipientRefusal(response: CallToolResponse): CallToolResponse {
  return isRecipientRefusal(response) ? refusal(RECIPIENT_NOT_LISTED) : response;
}

/**
 * Keeps each chat's Email account names per connector address. A fresh read replaces what is kept, and a
 * failed read is not kept, so the next call reads again.
 */
export class MailAccountDirectory {
  readonly #byChat = new Map<string, Promise<readonly string[]>>();

  accounts({
    chat_id,
    connector_url,
    fresh,
    read,
  }: {
    chat_id: string;
    connector_url: string;
    fresh: boolean;
    read: () => Promise<readonly string[]>;
  }): Promise<readonly string[]> {
    const key = JSON.stringify([chat_id, connector_url]);
    const cached = this.#byChat.get(key);
    if (cached !== undefined && !fresh) {
      return cached;
    }
    const made = read();
    this.#byChat.delete(key);
    this.#byChat.set(key, made);
    made.catch(() => {
      if (this.#byChat.get(key) === made) {
        this.#byChat.delete(key);
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
  readonly #accounts: (options: { fresh: boolean }) => Promise<readonly string[]>;
  readonly #now: () => Date;

  constructor({
    inner,
    accounts,
    now,
  }: {
    inner: ToolSource;
    /** The account names; `fresh` reads them again instead of using a kept list. */
    accounts: (options: { fresh: boolean }) => Promise<readonly string[]>;
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
    const account = await this.#accountFor({
      requested: given[MAIL_ACCOUNT_ARGUMENT],
      reads_only: isMailReadToolName(params.name),
    });
    if ('refused' in account) {
      return refusal(account.refused);
    }
    const args = withoutNullDates({ ...given, [MAIL_ACCOUNT_ARGUMENT]: account.name });
    const send = (sent: Record<string, unknown>) =>
      this.#inner.callTool({ ...params, arguments: sent }, approvalDecision, context);
    if (params.name !== MAIL_LIST_TOOL_NAME || args['since'] !== undefined) {
      const sent = await send(args);
      return isMailComposeToolName(params.name) ? plainRecipientRefusal(sent) : sent;
    }
    const before = args['before'];
    const parsedBefore = typeof before === 'string' ? Date.parse(before) : Number.NaN;
    const upTo = Number.isNaN(parsedBefore) ? this.#now().getTime() : parsedBefore;
    const daysBefore = (days: number) => new Date(upTo - days * DAY_MS).toISOString();
    const wanted = typeof args['page_size'] === 'number' ? args['page_size'] : SIDECAR_DEFAULT_PAGE_SIZE;
    const recent = { order: 'desc', ...args };
    const first = await send({ ...recent, since: daysBefore(RECENT_WINDOW_DAYS) });
    if (!isCallToolResponseResult(first) || first.result.isError === true) {
      return first;
    }
    if (emailsOfResult(first.result).length >= wanted) {
      return first;
    }
    return send({ ...recent, since: daysBefore(WIDER_WINDOW_DAYS) });
  }

  async #readAccounts(fresh: boolean): Promise<readonly string[] | undefined> {
    try {
      return await this.#accounts({ fresh });
    } catch {
      return undefined;
    }
  }

  /**
   * The account the call goes to. A name left out is filled in when there is one account. A name not on the
   * list is refused, except that a read with one account goes to that account. Anything but a read uses a
   * fresh list, and a kept list is read again before a name is refused.
   */
  async #accountFor({
    requested,
    reads_only,
  }: {
    requested: unknown;
    reads_only: boolean;
  }): Promise<{ name: string } | { refused: string }> {
    let names = await this.#readAccounts(!reads_only);
    if (names !== undefined && reads_only && !isAccountLeftOut(requested) && !names.some(name => name === requested)) {
      names = await this.#readAccounts(true);
    }
    const [only, ...others] = names ?? [];
    if (names === undefined || only === undefined) {
      return { refused: ACCOUNTS_UNREADABLE };
    }
    const listed = names.map(name => `'${name}'`).join(', ');
    if (isAccountLeftOut(requested)) {
      return others.length === 0
        ? { name: only }
        : { refused: `Say which Email account to use. The accounts are ${listed}.` };
    }
    const match = names.find(name => name === requested);
    if (match !== undefined) {
      return { name: match };
    }
    if (reads_only && others.length === 0) {
      return { name: only };
    }
    const named = typeof requested === 'string' ? `named '${requested}'` : 'by that name';
    return {
      refused: `There is no Email account ${named}. The accounts are ${listed}; use one of these names, or leave the name out when there is one account.`,
    };
  }
}
