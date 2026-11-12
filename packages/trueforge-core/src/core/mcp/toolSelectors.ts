import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP server tool selectors are either a special tag or a literal tool name.
 *
 *   @all          — every tool on the server
 *   @read-only    — readOnlyHint === true
 *   @write        — readOnlyHint === false and not destructive
 *   @destructive   — destructiveHint === true
 *   @unclassified — annotations do not establish readOnlyHint === true (covers both
 *                   a completely unannotated tool and a partially annotated one)
 */
const TOOL_TAG_ALL = '@all';
/** Exported so a host narrowing a mount to reads names the tag rather than restating its literal. */
export const TOOL_TAG_READ_ONLY = '@read-only';
/** Exported so the approval gate can name the tag it waives for a call the host vouches for as a read. */
export const TOOL_TAG_WRITE = '@write';
const TOOL_TAG_DESTRUCTIVE = '@destructive';
/** Exported so a host that already vouches for a tool's read-only nature can name the tag it waives. */
export const TOOL_TAG_UNCLASSIFIED = '@unclassified';

const TOOL_TAGS = [
  TOOL_TAG_ALL,
  TOOL_TAG_READ_ONLY,
  TOOL_TAG_WRITE,
  TOOL_TAG_DESTRUCTIVE,
  TOOL_TAG_UNCLASSIFIED,
] as const;
type ToolTag = (typeof TOOL_TAGS)[number];

/** Tags allowed on `enable_tools`, `disable_tools`, and `preload_tools`. */
export const TOOLS_SELECTOR_TAGS = [TOOL_TAG_ALL, TOOL_TAG_READ_ONLY] as const;

/** Tags allowed on `require_approval_for_tools`. */
export const REQUIRE_APPROVAL_TOOLS_SELECTOR_TAGS = [
  TOOL_TAG_ALL,
  TOOL_TAG_WRITE,
  TOOL_TAG_DESTRUCTIVE,
  TOOL_TAG_UNCLASSIFIED,
] as const;

export const DEFAULT_ENABLE_TOOLS: string[] = [TOOL_TAG_ALL];
export const DEFAULT_DISABLE_TOOLS: string[] = [];
export const DEFAULT_PRELOAD_TOOLS: string[] = [];

/**
 * A server whose tool count at initialise time is at or below this, and whose spec does not set
 * `preload` explicitly, has its tool schemas exposed directly instead of going through the
 * list_tools/get_tool_info meta-tool round trip. Small connectors (a handful of tools) pay pure
 * latency for deferred discovery with none of its benefit (keeping a large catalog out of context).
 */
export const MCP_AUTO_PRELOAD_MAX_TOOLS = 8;
// Fail-closed: a tool whose annotations do not establish it as read-only (including a
// completely unannotated tool) is gated by default, alongside declared writes/destructive ones.
export const DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS: string[] = [
  TOOL_TAG_WRITE,
  TOOL_TAG_DESTRUCTIVE,
  TOOL_TAG_UNCLASSIFIED,
];

function isToolTag(selector: string): selector is ToolTag {
  return TOOL_TAGS.includes(selector as ToolTag);
}

function isReadOnly(annotations?: ToolAnnotations): boolean {
  return annotations?.readOnlyHint === true;
}

function isWrite(annotations?: ToolAnnotations): boolean {
  return annotations?.readOnlyHint === false && annotations.destructiveHint !== true;
}

function isDestructive(annotations?: ToolAnnotations): boolean {
  return annotations?.destructiveHint === true;
}

function isUnclassified(annotations?: ToolAnnotations): boolean {
  return !isReadOnly(annotations);
}

function toolMatchesTag(tag: ToolTag, annotations: ToolAnnotations | undefined): boolean {
  switch (tag) {
    case TOOL_TAG_ALL:
      return true;
    case TOOL_TAG_READ_ONLY:
      return isReadOnly(annotations);
    case TOOL_TAG_WRITE:
      return isWrite(annotations);
    case TOOL_TAG_DESTRUCTIVE:
      return isDestructive(annotations);
    case TOOL_TAG_UNCLASSIFIED:
      return isUnclassified(annotations);
  }
}

/** True if the tool matches any selector (tag or literal name). */
export function toolMatchesAnySelector(
  toolName: string,
  annotations: ToolAnnotations | undefined,
  selectors: readonly string[] | undefined,
): boolean {
  if (!selectors?.length) {
    return false;
  }

  for (const selector of selectors) {
    if (isToolTag(selector)) {
      if (toolMatchesTag(selector, annotations)) {
        return true;
      }
    } else if (selector === toolName) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the tool requires human approval before execution.
 * Matches `@write`, `@destructive`, `@unclassified`, `@all`, or explicit tool names against
 * annotations. Under the default `require_approval_for_tools`, an unannotated (or only
 * partially annotated) tool is gated, because it matches `@unclassified` — silence is never
 * read as permission. An operator who narrows `require_approval_for_tools` explicitly (e.g. to
 * `['@destructive']`, or to `[]` to opt out entirely) has that choice honored as configured.
 */
export function toolRequiresApproval(
  toolName: string,
  annotations: ToolAnnotations | undefined,
  selectors: readonly string[] | undefined,
): boolean {
  if (!selectors?.length) {
    return false;
  }
  return toolMatchesAnySelector(toolName, annotations, selectors);
}

/** True if the tool is enabled and not disabled. */
export function isToolAllowed(params: {
  toolName: string;
  annotations: ToolAnnotations | undefined;
  enableSelectors: readonly string[];
  disableSelectors: readonly string[];
}): boolean {
  const { toolName, annotations, enableSelectors, disableSelectors } = params;
  if (!toolMatchesAnySelector(toolName, annotations, enableSelectors)) {
    return false;
  }
  if (toolMatchesAnySelector(toolName, annotations, disableSelectors)) {
    return false;
  }
  return true;
}

/** Non-tag names from a selector list (for upfront validation / sandbox allow-lists). */
export function literalToolNames(selectors: readonly string[] | undefined): string[] {
  if (!selectors) {
    return [];
  }
  return selectors.filter(s => !isToolTag(s));
}

export function selectorsIncludeAll(selectors: readonly string[] | undefined): boolean {
  return !!selectors?.includes(TOOL_TAG_ALL);
}
