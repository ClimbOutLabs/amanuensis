import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../documents/toolContract';
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
import { isInboxName, resolveMailboxName, unknownMailboxText } from './mailboxNames';
import { resolveMailDates } from './mailDates';
import { accountNamesOfResult, emailsOfResult, mailboxesOfResult } from './mailToolResults';
import { isRecipientRefusal, RECIPIENT_NOT_LISTED } from './recipientRefusal';
import {
  isMailComposeToolName,
  isMailReadToolName,
  MAIL_ACCOUNT_ARGUMENT,
  MAIL_ACCOUNT_LIST_TOOL_NAME,
  MAIL_ATTACHMENT_TOOL_NAME,
  MAIL_CONNECTOR_TOOL_NAMES,
  MAIL_CONTENT_TOOL_NAME,
  MAIL_DRAFT_TOOL_NAME,
  MAIL_LIST_TOOL_NAME,
  MAIL_MAILBOX_ARGUMENTS,
  MAIL_MAILBOX_LIST_TOOL_NAME,
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
const ACCOUNT_NOTE = 'Leave it out to use the default account; it is filled in for you.';
const MAILBOX_NOTE = `A name from ${MAIL_MAILBOX_LIST_TOOL_NAME}. A common name such as Sent, Drafts, Trash or Spam is matched to this account's own folder.`;
/** The sidecar's catch-all for a mail server request that failed; its own words say nothing about what to do. */
const PROVIDER_FAILURE_WORDS = 'provider_failure';
const PROVIDER_FAILURE =
  'The mail server did not finish this request, so nothing was read. Try the same call once more. If it fails again, tell the person their mail server is not answering and to check the Email account in Settings.';
const DRAFT_RECIPIENT_NOTE =
  'Recipients the person named must stay on the call: a recipient who is not on the Email list is handled by an approval card shown to the person, and a draft with no recipient is refused. Never leave recipients off to get past a refusal.';
const RECENT_WINDOW_NOTE = `With no since date, this looks at the ${String(RECENT_WINDOW_DAYS)} days up to before (or up to now), then ${String(WIDER_WINDOW_DAYS)} days if fewer messages than asked for come back. Results are newest first within that window. Set since to look further back. A since or before with no time zone offset is read in the user's time zone.`;

// A file name alone is not a path the document reader can open without asking, so the model must fetch first.
const ATTACHMENT_NOTE = `To read an attachment, first call ${MAIL_ATTACHMENT_TOOL_NAME} for it. That saves the file in the sandbox and returns its path. Then call ${EXTRACT_DOCUMENT_TEXT_TOOL_NAME} with that path. Never pass an attachment's file name as the path.`;

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
        : tool.name === MAIL_CONTENT_TOOL_NAME || tool.name === MAIL_ATTACHMENT_TOOL_NAME
          ? `${tool.description ?? ''} ${ATTACHMENT_NOTE}`.trim()
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
        ...Object.fromEntries(
          MAIL_MAILBOX_ARGUMENTS.flatMap(key => {
            const mailbox = properties[key];
            if (!isRecord(mailbox)) {
              return [];
            }
            const said = typeof mailbox['description'] === 'string' ? `${mailbox['description']} ` : '';
            return [[key, { ...mailbox, description: `${said}${MAILBOX_NOTE}` }]];
          }),
        ),
        [MAIL_ACCOUNT_ARGUMENT]: { ...account, description: `${accountDescription}${ACCOUNT_NOTE}` },
      },
      ...(required === undefined ? {} : { required: required.filter(name => name !== MAIL_ACCOUNT_ARGUMENT) }),
    },
  };
}

function refusal(text: string): CallToolResponse {
  return toolResultResponse({ text: JSON.stringify({ error: text }), isError: true });
}

/** The words of a call's error result, or undefined when it did not fail. */
function errorText(response: CallToolResponse): string | undefined {
  if (!isCallToolResponseResult(response) || response.result.isError !== true) {
    return undefined;
  }
  return response.result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n');
}

/**
 * A read the mail server failed comes back as the sidecar's bare catch-all. It becomes a plain error that
 * says what to do next. Only reads: trying a send again could send it twice.
 */
function plainReadFailure(response: CallToolResponse): CallToolResponse {
  return errorText(response)?.includes(PROVIDER_FAILURE_WORDS) === true ? refusal(PROVIDER_FAILURE) : response;
}

/** The sidecar's raw recipient refusal, in whichever text block it arrived, becomes the plain stop. */
function plainRecipientRefusal(response: CallToolResponse): CallToolResponse {
  return isRecipientRefusal(response) ? refusal(RECIPIENT_NOT_LISTED) : response;
}

/**
 * What one read of the Email accounts settles for a chat: every connected account, which of them is
 * the default, and which of them this chat's persona may use (null when the persona is not limited).
 */
export interface MailAccountSnapshot {
  names: readonly string[];
  default_name: string | null;
  allowed: readonly string[] | null;
}

/**
 * Keeps each chat's Email account snapshot per connector address. A fresh read replaces what is kept, and a
 * failed read is not kept, so the next call reads again.
 */
export class MailAccountDirectory {
  readonly #byChat = new Map<string, Promise<MailAccountSnapshot>>();

  accounts({
    chat_id,
    connector_url,
    fresh,
    read,
  }: {
    chat_id: string;
    connector_url: string;
    fresh: boolean;
    read: () => Promise<MailAccountSnapshot>;
  }): Promise<MailAccountSnapshot> {
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

/**
 * Reads the account snapshot the sidecar settles: the connected account names. The sidecar names no
 * default and no persona limit, so both stay unset here; the host layers its own routing on top.
 * Throws when the list cannot be read or names no account.
 */
export async function readMailAccountSnapshot(source: Pick<ToolSource, 'callTool'>): Promise<MailAccountSnapshot> {
  const response = await source.callTool({ name: MAIL_ACCOUNT_LIST_TOOL_NAME, arguments: {} });
  if (!isCallToolResponseResult(response) || response.result.isError === true) {
    throw new Error('The Email sidecar did not return its account list.');
  }
  const names = accountNamesOfResult(response.result);
  if (names.length === 0) {
    throw new Error('The Email sidecar listed no account.');
  }
  return { names, default_name: null, allowed: null };
}

/**
 * The Email connector as the model sees it. The host fills in the account name, so the model never has to
 * know it, and a list call with no date only looks at recent mail, so it never scans the whole mailbox.
 */
export class MailConnectorSource implements ToolSource {
  readonly #inner: ToolSource;
  readonly #accounts: (options: { fresh: boolean }) => Promise<MailAccountSnapshot>;
  readonly #now: () => Date;
  readonly #timeZone: string | undefined;

  constructor({
    inner,
    accounts,
    now,
    timeZone,
  }: {
    inner: ToolSource;
    /** The account snapshot; `fresh` reads it again instead of using a kept one. */
    accounts: (options: { fresh: boolean }) => Promise<MailAccountSnapshot>;
    now: () => Date;
    /** The user's IANA time zone, in which a date the model gives without an offset is read; UTC when unknown. */
    timeZone: string | undefined;
  }) {
    this.#inner = inner;
    this.#accounts = accounts;
    this.#now = now;
    this.#timeZone = timeZone;
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

  get grantBinding(): string | undefined {
    return this.#inner.grantBinding;
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
      picked: approvalDecision?.status === 'allow' ? approvalDecision.from_account : undefined,
    });
    if ('refused' in account) {
      return refusal(account.refused);
    }
    const dated = resolveMailDates({
      args: withoutNullDates({ ...given, [MAIL_ACCOUNT_ARGUMENT]: account.name }),
      time_zone: this.#timeZone,
    });
    if (!dated.ok) {
      return refusal(dated.error);
    }
    const foldered = await this.#withAccountFolders(dated.args);
    if ('refused' in foldered) {
      return refusal(foldered.refused);
    }
    const { args } = foldered;
    const readsOnly = isMailReadToolName(params.name);
    const send = async (sent: Record<string, unknown>) => {
      const response = await this.#inner.callTool({ ...params, arguments: sent }, approvalDecision, context);
      return readsOnly ? plainReadFailure(response) : response;
    };
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

  /**
   * Puts the account's own name for each folder the call names. Providers name standard folders differently,
   * and the server fails on a name it does not have. When the folder list cannot be read, the call goes as given.
   */
  async #withAccountFolders(
    args: Record<string, unknown>,
  ): Promise<{ args: Record<string, unknown> } | { refused: string }> {
    const named = MAIL_MAILBOX_ARGUMENTS.flatMap(key => {
      const value = args[key];
      return typeof value === 'string' && value !== '' && !isInboxName(value) ? [{ key, value }] : [];
    });
    if (named.length === 0) {
      return { args };
    }
    const listed = await this.#inner.callTool({
      name: MAIL_MAILBOX_LIST_TOOL_NAME,
      arguments: { [MAIL_ACCOUNT_ARGUMENT]: args[MAIL_ACCOUNT_ARGUMENT] },
    });
    const mailboxes =
      isCallToolResponseResult(listed) && listed.result.isError !== true ? mailboxesOfResult(listed.result) : [];
    if (mailboxes.length === 0) {
      return { args };
    }
    const resolved = { ...args };
    for (const { key, value } of named) {
      const name = resolveMailboxName({ requested: value, mailboxes });
      if (name === undefined) {
        return { refused: unknownMailboxText({ requested: value, mailboxes }) };
      }
      resolved[key] = name;
    }
    return { args: resolved };
  }

  async #readAccounts(fresh: boolean): Promise<MailAccountSnapshot | undefined> {
    try {
      return await this.#accounts({ fresh });
    } catch {
      return undefined;
    }
  }

  /**
   * The account the call goes to. The person's pick on an approval card wins over everything: an
   * approval stays with the account it was given on. A name left out is filled with the default
   * account, or the first usable one when the default is not usable in this chat. A name outside
   * this chat persona's accounts is refused, and a read with one usable account goes to that
   * account even when the name is off. Anything but a read uses a fresh list, and a kept list is
   * read again before a name is refused.
   */
  async #accountFor({
    requested,
    reads_only,
    picked,
  }: {
    requested: unknown;
    reads_only: boolean;
    /** The account the person picked on the approval card for this call, when they picked one. */
    picked: string | undefined;
  }): Promise<{ name: string } | { refused: string }> {
    let snapshot = await this.#readAccounts(!reads_only);
    if (
      snapshot !== undefined &&
      reads_only &&
      !isAccountLeftOut(requested) &&
      !snapshot.names.some(name => name === requested)
    ) {
      snapshot = await this.#readAccounts(true);
    }
    if (snapshot === undefined || snapshot.names.length === 0) {
      return { refused: ACCOUNTS_UNREADABLE };
    }
    const usable =
      snapshot.allowed === null
        ? snapshot.names
        : snapshot.names.filter(name => snapshot.allowed?.includes(name) === true);
    const listed = usable.map(name => `'${name}'`).join(', ');
    if (picked !== undefined) {
      return usable.some(name => name === picked)
        ? { name: picked }
        : {
            refused:
              'The account picked on the approval card cannot be used for this send, so nothing was sent. ' +
              `The accounts this chat can use are ${listed}.`,
          };
    }
    if (usable.length === 0) {
      return {
        refused: 'This persona cannot use any of the connected Email accounts, so nothing was done.',
      };
    }
    const [first] = usable;
    if (first === undefined) {
      return { refused: ACCOUNTS_UNREADABLE };
    }
    if (isAccountLeftOut(requested)) {
      return {
        name:
          snapshot.default_name !== null && usable.some(name => name === snapshot.default_name)
            ? snapshot.default_name
            : first,
      };
    }
    const match = usable.find(name => name === requested);
    if (match !== undefined) {
      return { name: match };
    }
    if (reads_only && usable.length === 1) {
      return { name: first };
    }
    if (typeof requested === 'string' && snapshot.names.some(name => name === requested)) {
      return {
        refused: `This persona cannot use the Email account '${requested}'. The accounts it can use are ${listed}.`,
      };
    }
    const named = typeof requested === 'string' ? `named '${requested}'` : 'by that name';
    return {
      refused: `There is no Email account ${named}. The accounts are ${listed}; use one of these names, or leave the name out to use the default account.`,
    };
  }
}
