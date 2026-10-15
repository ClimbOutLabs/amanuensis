/**
 * Server-side `requires_network` annotation for Sentinel offline mode.
 *
 * Populated from this hand-curated per-tool registry, not from tool
 * self-declaration. Trusted only for first-party/server-authored tools;
 * third-party and MCP tools default to `requires_network: true` unless
 * individually reviewed (the reviewed set below). Consulted both when
 * filtering the model-visible tool list and at call time for the
 * stale-context guard.
 */

/** Tool provenance for the network annotation. */
export type ToolProvenance = 'first-party' | 'third-party';

/**
 * Hand-curated first-party network requirements. Unknown first-party tools
 * fail closed to true.
 */
const FIRST_PARTY_REQUIRES_NETWORK: Record<string, boolean> = {
  // Sandbox tools run against the local sandbox: no network by construction.
  exec: false,
  run_code: false,
  apply_patch: false,
  replace_text: false,
  write_file: false,
  run_registered_command: false,
  run_workflow: false,
  submit_implementation_plan: false,
  // Local builtins.
  ask_user_question: false,
  get_current_datetime: false,
  extract_document_text: false,
  create_document_report: false,
  summarize_net_worth: false,
  create_sub_agent: false,
  get_openui_instructions: false,
  replace_task_checklist: false,
  // Networked builtins.
  web_search: true,
  // Embedded maps: geocoding, routing, and tiles all leave the machine.
  render_map: true,
  render_route: true,
};

/**
 * Individually reviewed third-party/MCP tools that provably need no network.
 * Everything else third-party defaults to requires_network: true.
 */
const REVIEWED_THIRD_PARTY_NO_NETWORK: ReadonlySet<string> = new Set([
  // Empty until a third-party tool is individually reviewed. Additions require
  // a reviewer to confirm the tool cannot reach the network.
]);

/** Server-side network annotation for a tool. Fail-closed default: true. */
export function requiresNetwork(input: { tool_name: string; provenance: ToolProvenance }): boolean {
  if (input.provenance === 'third-party') {
    return REVIEWED_THIRD_PARTY_NO_NETWORK.has(input.tool_name) ? false : true;
  }
  return FIRST_PARTY_REQUIRES_NETWORK[input.tool_name] ?? true;
}

/**
 * Provenance of a tool call for the network annotation. Sandbox and
 * truefoundry-system tools are first-party; mcp tools are third-party.
 */
export function provenanceForToolType(toolType: 'truefoundry-system' | 'mcp'): ToolProvenance {
  return toolType === 'mcp' ? 'third-party' : 'first-party';
}
