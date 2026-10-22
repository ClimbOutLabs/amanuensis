import type { ChatCompletionFunctionTool, ChatCompletionTool } from 'openai/resources/chat';
import { z } from 'zod';
import type { AgentCapability, JsonValue } from '../capabilities/AgentCapability';
import type { AgentThreadExecutionContext } from '../capabilities/AgentContextProcessor';
import { ASK_USER_QUESTION_TOOL_NAME } from '../capabilities/builtins/AskUserQuestion';
import { GET_CURRENT_DATETIME_TOOL_NAME } from '../capabilities/builtins/CurrentDateTime';
import type { RawToolCall } from '../llm/LLMTypes';
import type { ConvertToolsResult } from '../mcp/convertMCPServers';
import type { IToolSet } from '../mcp/IMCPServer';
import { parseToolCallArguments } from '../mcp/toolArgumentCheck';
import { InternalEventType } from './AgentThread.types';
import { isLLMContextMessage } from './contextUtils';
import { CALL_TOOL_NAME, GET_TOOL_INFO_NAME } from './DeferredTool';

export const TOOL_INDEX_STATE_KEY = 'tfy.tool_index';

/** Sent in full on every turn: the model needs them before it has looked anything up. */
const ALWAYS_LOADED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ASK_USER_QUESTION_TOOL_NAME,
  GET_CURRENT_DATETIME_TOOL_NAME,
]);

/** Most tools one chat keeps fully loaded; the least recently used drops back to the index. */
export const MAX_PROMOTED_TOOLS = 24;

/** Longest one-line summary in the index; longer first sentences are cut at a word. */
const MAX_SUMMARY_LENGTH = 90;

const ToolIndexStateSchema = z.object({ promoted: z.array(z.string()) });

type ToolIndexState = z.infer<typeof ToolIndexStateSchema>;

export interface ToolIndexEntry {
  /** The name the model calls the tool by. */
  name: string;
  /** The tool set that serves it, as call_tool and get_tool_info name it. */
  server: string;
  /** The tool name on that tool set. */
  originalName: string;
  summary: string;
  definition: ChatCompletionFunctionTool;
  /** Sent in full on every request, so never listed or promoted; still found by name for call_tool. */
  alwaysLoaded: boolean;
}

/** The first sentence of a tool description, without the `mcp server:` line the converter adds. */
function summarize(description: string): string {
  const body = description.replace(/^mcp server: [^\n]*\n/, '').trim();
  const firstLine = body.split('\n')[0] ?? '';
  const sentence = (/^.*?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine).trim();
  if (sentence.length <= MAX_SUMMARY_LENGTH) {
    return sentence;
  }
  const cut = sentence.slice(0, MAX_SUMMARY_LENGTH);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}...`;
}

/**
 * Tools the model sees as one line each until it first uses them. A lookup or a call promotes a
 * tool, and a promoted tool is sent with its full definition for the rest of the chat.
 */
export class ToolIndex {
  private entries: ToolIndexEntry[] = [];
  private byName = new Map<string, ToolIndexEntry>();
  private promoted: string[] = [];
  // Indexed tools left out of the listing for now, such as network tools while the user is offline.
  private withheld = new Set<string>();
  // The lookup tools are only sent when there is something to look up.
  private unusedMetaTools = new Set<string>();

  /**
   * Builds the index from the converted tool list. Tools served by `metaToolSet` stay loaded while
   * anything is indexed or `deferredServers` holds connectors whose tools are not listed.
   */
  load(input: { converted: ConvertToolsResult; metaToolSet: IToolSet | undefined; deferredServers: boolean }): void {
    const entries: ToolIndexEntry[] = [];
    const metaTools = new Set<string>();
    for (const definition of input.converted.tools) {
      if (definition.type !== 'function') {
        continue;
      }
      const mapped = input.converted.toolMapping.get(definition.function.name);
      if (mapped !== undefined && mapped.toolSet === input.metaToolSet) {
        metaTools.add(definition.function.name);
        continue;
      }
      if (mapped === undefined) {
        continue;
      }
      entries.push({
        name: definition.function.name,
        server: mapped.toolSet.name,
        originalName: mapped.originalToolName,
        summary: summarize(definition.function.description ?? ''),
        definition,
        alwaysLoaded: ALWAYS_LOADED_TOOL_NAMES.has(mapped.originalToolName),
      });
    }
    this.entries = entries;
    this.byName = new Map(entries.map(entry => [entry.name, entry]));
    this.unusedMetaTools = entries.some(entry => !entry.alwaysLoaded) || input.deferredServers ? new Set() : metaTools;
  }

  /** Every tool call_tool can reach, whether or not it is listed right now. */
  list(): readonly ToolIndexEntry[] {
    return this.entries;
  }

  /** The indexed tools the model is told about now. */
  listed(): readonly ToolIndexEntry[] {
    return this.entries.filter(entry => !entry.alwaysLoaded && !this.withheld.has(entry.name));
  }

  /** Lists only the indexed tools among `available`. Returns whether the listing changed. */
  withhold(available: readonly ChatCompletionTool[]): boolean {
    const availableNames = new Set(available.flatMap(tool => (tool.type === 'function' ? [tool.function.name] : [])));
    const next = new Set(this.entries.filter(entry => !availableNames.has(entry.name)).map(entry => entry.name));
    const changed = next.size !== this.withheld.size || [...next].some(name => !this.withheld.has(name));
    this.withheld = next;
    return changed;
  }

  /**
   * The indexed tool a server and tool name point at. An exact server match wins; otherwise the
   * name alone decides, since every indexed name is unique.
   */
  find(input: { server: string; name: string }): ToolIndexEntry | undefined {
    const exact = this.entries.find(entry => entry.server === input.server && entry.originalName === input.name);
    if (exact !== undefined) {
      return exact;
    }
    const byName = this.byName.get(input.name);
    if (byName !== undefined) {
      return byName;
    }
    const byOriginal = this.entries.filter(entry => entry.originalName === input.name);
    return byOriginal.length === 1 ? byOriginal[0] : undefined;
  }

  /** The tools to send: everything not indexed, plus the indexed tools this chat has promoted. */
  requestTools(tools: readonly ChatCompletionTool[]): ChatCompletionTool[] {
    const promoted = new Set(this.promoted);
    return tools.filter(tool => {
      if (tool.type !== 'function') {
        return true;
      }
      const entry = this.byName.get(tool.function.name);
      return entry === undefined
        ? !this.unusedMetaTools.has(tool.function.name)
        : entry.alwaysLoaded || promoted.has(entry.name);
    });
  }

  /** The indexed tool a call uses or looks up, if any. */
  private usedBy(call: RawToolCall): ToolIndexEntry | undefined {
    const args = parseToolCallArguments(call);
    const server = args?.['mcp_server'];
    const name = args?.['tool_name'];
    const entry =
      call.function.name === GET_TOOL_INFO_NAME || call.function.name === CALL_TOOL_NAME
        ? typeof server === 'string' && typeof name === 'string'
          ? this.find({ server, name })
          : undefined
        : this.byName.get(call.function.name);
    return entry?.alwaysLoaded === true ? undefined : entry;
  }

  /**
   * The promoted list after the given calls, oldest first and bounded. A tool used again moves to
   * the end, so the least recently used drops out first.
   */
  private promotedAfter(calls: readonly RawToolCall[]): string[] {
    const next = [...this.promoted];
    for (const call of calls) {
      const entry = this.usedBy(call);
      if (entry === undefined) {
        continue;
      }
      const at = next.indexOf(entry.name);
      if (at !== -1) {
        next.splice(at, 1);
      }
      next.push(entry.name);
    }
    return next.slice(-MAX_PROMOTED_TOOLS);
  }

  /** Records the calls' promotions: the new list is saved before this index uses it. */
  private async *promote(calls: readonly RawToolCall[]) {
    await Promise.resolve();
    const next = this.promotedAfter(calls);
    if (next.length === this.promoted.length && next.every((name, i) => name === this.promoted[i])) {
      return;
    }
    const state: ToolIndexState = { promoted: next };
    yield { type: InternalEventType.CAPABILITY_STATE, key: TOOL_INDEX_STATE_KEY, state };
    this.promoted = next;
  }

  /**
   * Durable promotion: restored from the chat's saved state, and refreshed from the chat's calls
   * once their results are in (so the next request already carries the tools) and again before
   * each model request (covering a chat resumed after a restart or an approval).
   */
  capability(): AgentCapability {
    const promoteFromContext = (execution: Readonly<AgentThreadExecutionContext>) =>
      this.promote(
        execution.context.flatMap(message =>
          isLLMContextMessage(message) && message.role === 'assistant' ? (message.tool_calls ?? []) : [],
        ),
      );
    return {
      state: {
        key: TOOL_INDEX_STATE_KEY,
        load: (state: JsonValue) => {
          const parsed = ToolIndexStateSchema.safeParse(state);
          this.promoted = parsed.success ? parsed.data.promoted.slice(-MAX_PROMOTED_TOOLS) : [];
        },
      },
      preLLMProcessors: [{ processPreLLM: promoteFromContext }],
      postToolCallProcessors: [{ processPostToolCall: promoteFromContext }],
    };
  }
}
