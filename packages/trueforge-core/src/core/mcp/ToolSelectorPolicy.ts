import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AgentToolSchema } from './IMCPServer';
import {
  DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS,
  isToolAllowed,
  literalToolNames,
  MCP_AUTO_PRELOAD_MAX_TOOLS,
  selectorsIncludeAll,
  TOOL_TAG_UNCLASSIFIED,
  TOOL_TAG_WRITE,
  toolMatchesAnySelector,
  toolRequiresApproval,
} from './toolSelectors';

/**
 * Per-server tool selectors. Enable/disable/preload tags: `@all`, `@read-only`.
 * Approval tags: `@all`, `@write`, `@destructive`, `@unclassified`.
 */
export interface ToolSelectorConfig {
  enableTools: string[];
  disableTools: string[];
  preloadTools: string[];
  requireApprovalForTools?: string[] | undefined;
}

/**
 * Encapsulates enable/disable/preload/approval selector policy for a single MCP server. Pure: it
 * never throws or does IO — callers decide how to surface a disallowed/missing tool so each can
 * raise its own error type.
 *
 * `preload` is a tri-state input: `true`/`false` are an explicit spec choice and are honored as
 * given; `undefined` means the spec left it unset, so this server is a candidate for automatic
 * preload once its tool count is known (see `resolveAutoPreload`/`degradeAutoPreloadOnFailure`,
 * both driven by `filterAndAnnotate`, the only place a real tool list — or its absence — reaches
 * this class). A non-empty `preloadTools` list is documented (agentSpec.ts) to imply `preload:
 * false`, so it also opts a server out of auto-detection, the same as an explicit `false`.
 */
export class ToolSelectorPolicy {
  private readonly explicitPreload: boolean | undefined;
  // Set once filterAndAnnotate() sees a real tool list (or a failed probe) for an auto-mode
  // server. undefined until then; `preload` falls back to a conservative `false` in that window so
  // callers built before resolution (e.g. instruction text assembled at agent construction) treat
  // an undecided server as deferred rather than silently dropping it from discovery guidance.
  private resolvedAutoPreload: boolean | undefined;

  private readonly enableTools: string[];
  private readonly disableTools: string[];
  private readonly preloadTools: string[];
  private readonly requireApprovalForTools: string[];
  // Tool names that survived enable/disable filtering on the most recent filterAndAnnotate() call.
  // Used by the sandbox allow-list and as the fast path for callTool gating.
  private resolvedAllowedToolNames: string[] | undefined;

  constructor(params: { selectors: ToolSelectorConfig; preload: boolean | undefined }) {
    this.enableTools = params.selectors.enableTools;
    this.disableTools = params.selectors.disableTools;
    this.preloadTools = params.selectors.preloadTools;
    this.requireApprovalForTools = params.selectors.requireApprovalForTools ?? DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS;
    // A non-empty preload_tools list is a deliberate selective-preload choice; treat it like an
    // explicit `preload: false` rather than letting auto-detection override it.
    this.explicitPreload = params.preload ?? (this.preloadTools.length > 0 ? false : undefined);
  }

  get preload(): boolean {
    return this.explicitPreload ?? this.resolvedAutoPreload ?? false;
  }

  get hasPreloadedTools(): boolean {
    return this.preload || this.preloadTools.length > 0;
  }

  /**
   * True while this server's preload is still undecided: no explicit spec value and no resolved
   * auto-detection outcome yet. Callers that gate a listTools() call on "does this look worth
   * loading" (e.g. convertMCPServers' OAuth-avoidance filter) must still let an undecided server
   * through, or its tool count is never learned and auto-preload can never fire.
   */
  get preloadPending(): boolean {
    return this.explicitPreload === undefined && this.resolvedAutoPreload === undefined;
  }

  /** Literal enable_tools names that are not present on the server (caller throws if non-empty). */
  missingEnableLiterals(tools: AgentToolSchema[]): string[] {
    const availableNames = new Set(tools.map(t => t.name));
    return literalToolNames(this.enableTools).filter(name => !availableNames.has(name));
  }

  /**
   * Filter by enable/disable, record the resolved allow-list, and annotate per-tool preload.
   * Also resolves auto-preload (first call only, for a server whose spec left `preload` unset):
   * `tools.length` at or below `MCP_AUTO_PRELOAD_MAX_TOOLS` preloads the server, above it defers.
   */
  filterAndAnnotate(tools: AgentToolSchema[]): AgentToolSchema[] {
    this.resolveAutoPreload(tools.length);
    const filtered = tools.filter(tool =>
      isToolAllowed({
        toolName: tool.name,
        annotations: tool.annotations,
        enableSelectors: this.enableTools,
        disableSelectors: this.disableTools,
      }),
    );
    this.resolvedAllowedToolNames = filtered.map(t => t.name);
    return filtered.map(tool => ({ ...tool, preload: this.isToolPreloaded(tool.name, tool.annotations) }));
  }

  /** Idempotent: only the first call (per instance) with an unresolved auto-mode server decides. */
  private resolveAutoPreload(toolCount: number): void {
    if (this.explicitPreload !== undefined || this.resolvedAutoPreload !== undefined) {
      return;
    }
    this.resolvedAutoPreload = toolCount <= MCP_AUTO_PRELOAD_MAX_TOOLS;
  }

  /**
   * Called when the probe that would have supplied a tool count (the server's own listTools())
   * failed instead. Only takes effect for an unresolved auto-mode server; degrades it to deferred
   * so the meta-tool round trip stays available. The failure itself surfaces normally the next
   * time this server is actually used (list_tools/get_tool_info/call_tool wrap the same
   * connection error into their tool result text) — this method exists only so one failed probe
   * doesn't also throw out of a batched listTools() call for every other server.
   */
  degradeAutoPreloadOnFailure(): void {
    if (this.explicitPreload !== undefined || this.resolvedAutoPreload !== undefined) {
      return;
    }
    this.resolvedAutoPreload = false;
  }

  private isToolPreloaded(toolName: string, annotations: ToolAnnotations | undefined): boolean {
    // Fully-preloaded server: every allowed tool is loaded into context.
    if (this.preload) {
      return true;
    }
    // Otherwise only the tools matching `preload_tools` stay eager.
    return toolMatchesAnySelector(toolName, annotations, this.preloadTools);
  }

  /**
   * Whether a tool may be called. Uses the resolved allow-list once listTools() has run; before that
   * falls back to matching against the raw selectors, resolving annotations lazily only when needed.
   */
  async isAllowed(toolName: string, resolveAnnotations: () => Promise<ToolAnnotations | undefined>): Promise<boolean> {
    if (this.resolvedAllowedToolNames) {
      return this.resolvedAllowedToolNames.includes(toolName);
    }
    return isToolAllowed({
      toolName,
      annotations: await resolveAnnotations(),
      enableSelectors: this.enableTools,
      disableSelectors: this.disableTools,
    });
  }

  /**
   * Best-effort allow-list for the sandbox. After a listTools() call returns the concrete names;
   * before that, `@all` with no disables means "unrestricted" (undefined), else the literal names.
   */
  allowedNamesForSandbox(): string[] | undefined {
    if (this.resolvedAllowedToolNames) {
      return this.resolvedAllowedToolNames;
    }
    if (selectorsIncludeAll(this.enableTools) && this.disableTools.length === 0) {
      return undefined;
    }
    return literalToolNames(this.enableTools);
  }

  /**
   * Whether the tool requires human approval. Honors `requireApprovalForTools` exactly: omit /
   * undefined defaults to write+destructive+unclassified, i.e. fail-closed (constructor); an
   * explicit list — including empty — is exact.
   *
   * `waiveWriteAndUnclassifiedForHostVouchedRead` lets a call the host already vouches for as a read
   * (the user's search provider running a tool its own list names, the operator's own Email or
   * Calendar sidecar reading the person's own data, a standing grant) pass the two tags in the
   * default list that gate on how a tool describes itself: `@write` and `@unclassified`. A tool can
   * carry the write tag only because an optional argument can change something, the mail server's
   * mark-as-read choice being the standing example, and the classifier has already judged this call
   * a read with that choice off. `@destructive` is never waived. The waiver applies to the default
   * list alone: a list the user changed in any way, `@all`, or a literal tool name is the user's
   * explicit choice and still gates.
   */
  requiresApproval(
    toolName: string,
    annotations: ToolAnnotations | undefined,
    options?: { waiveWriteAndUnclassifiedForHostVouchedRead: boolean },
  ): boolean {
    const selectors =
      options?.waiveWriteAndUnclassifiedForHostVouchedRead === true && this.usesDefaultApproval()
        ? this.requireApprovalForTools.filter(
            selector => selector !== TOOL_TAG_WRITE && selector !== TOOL_TAG_UNCLASSIFIED,
          )
        : this.requireApprovalForTools;
    return toolRequiresApproval(toolName, annotations, selectors);
  }

  /** The agent spec fills the default in when the user sets nothing, so equal to it counts as unset. */
  private usesDefaultApproval(): boolean {
    const defaults = new Set(DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS);
    return (
      this.requireApprovalForTools.length === defaults.size &&
      this.requireApprovalForTools.every(selector => defaults.has(selector))
    );
  }
}
