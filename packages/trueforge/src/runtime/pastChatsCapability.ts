/**
 * The `search_past_chats` built-in: a read-only tool that searches the person's own earlier
 * chats when they ask. A persona sees the chats its memory may recall from: its own, the main
 * assistant's, and those of personas that share their memory with it. It is only offered while
 * the person has the past-chat search switch on in Settings; the resolver leaves it out otherwise.
 */
import {
  defineTool,
  LocalToolMCP,
  toolResultResponse,
  type AgentCapability,
  type AgentTracing,
  type CallToolResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import type { IPersonaStore } from '../db/personaStore';
import type { VaultScope } from './memory/markdownMemoryFiles';
import {
  PastChatsDateError,
  renderPastChatsText,
  SEARCH_PAST_CHATS_INPUT_SCHEMA,
  searchablePersonaIds,
  searchPastChats,
  type PastChatsSessionReader,
  type SearchPastChatsInput,
} from './pastChats';

export const PAST_CHATS_SERVER_ID = 'past_chats';
export const SEARCH_PAST_CHATS_TOOL_NAME = 'search_past_chats';

const SEARCH_PAST_CHATS_DESCRIPTION =
  "Search the signed-in person's own earlier chats for the words in the query, in the chats this assistant may remember (its own, the main assistant's, and those shared with it), and return up to 8 matches with each chat's title, date, a short snippet and its chat id. Use it when the person asks what was decided, said or planned in an earlier chat. The chat happening now is never included. Dates are optional: from_date and to_date narrow the search to messages sent in that range.";

/** What decides which earlier chats a turn may search. */
export interface PastChatsReaders {
  sessionStore: PastChatsSessionReader;
  personaStore: Pick<IPersonaStore, 'listPersonas'>;
  /** Where the memory sharing settings live; they decide which personas' chats are shared. */
  memoryDir: string;
  /** The persona answering the turn; absent for the main assistant. */
  scope: VaultScope | undefined;
}

/** Present only while the person has the past-chat search switch on; absent leaves the tool out entirely. */
export interface PastChatsTurnContext extends PastChatsReaders {
  authority: { tenantId: string; userRef: string };
}

export interface PastChatsCapabilityOptions extends PastChatsReaders {
  authority: { tenantId: string; userRef: string; currentSessionId: string };
  tracing: AgentTracing;
}

class PastChatsTool extends LocalToolMCP {
  readonly name = PAST_CHATS_SERVER_ID;
  readonly displayName = 'Past chats';
  protected override readonly bundle: ToolBundleName = 'extras';

  constructor(private readonly options: PastChatsCapabilityOptions) {
    super({ tracing: options.tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: SEARCH_PAST_CHATS_TOOL_NAME,
      description: SEARCH_PAST_CHATS_DESCRIPTION,
      schema: SEARCH_PAST_CHATS_INPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: input => this.search(input),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  private async search(input: SearchPastChatsInput): Promise<CallToolResponse> {
    const { sessionStore, personaStore, memoryDir, scope, authority } = this.options;
    try {
      const personaIds = await searchablePersonaIds({
        memoryDir,
        tenantId: authority.tenantId,
        userRef: authority.userRef,
        scope,
        personaStore,
      });
      const hits = await searchPastChats({
        sessionStore,
        tenantId: authority.tenantId,
        userRef: authority.userRef,
        currentSessionId: authority.currentSessionId,
        personaIds,
        input,
      });
      return toolResultResponse({ text: renderPastChatsText(hits) });
    } catch (error) {
      if (error instanceof PastChatsDateError) {
        return toolResultResponse({ text: error.message, isError: true });
      }
      throw error;
    }
  }

  // A read of the person's own chats: it gets no approval prompt, like the usage read.
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

export function pastChatsCapability(options: PastChatsCapabilityOptions): AgentCapability {
  return { systemToolSets: [new PastChatsTool(options)] };
}
