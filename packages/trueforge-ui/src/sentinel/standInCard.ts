import { isRecord } from '../utils/sessionTimelineEvents.js';
import { MCP_META_TOOLS } from '../utils/toolCallParsing.js';

import type { SentinelApprovalCard } from './types.js';

/** `draft_email` reads as `draft email`. */
function toolWords(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words === '' ? 'a tool' : words;
}

function parsedArgs(argsText: string | undefined): unknown {
  if (argsText === undefined || argsText.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(argsText);
    return parsed;
  } catch {
    return argsText;
  }
}

/** One "name: value" line per argument, the way a server card lists what a connector gets. */
function argumentLines(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (!isRecord(args)) return typeof args === 'string' ? args : JSON.stringify(args);
  const lines = Object.entries(args).map(
    ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  return lines.length === 0 ? null : lines.join('\n');
}

/**
 * The card a waiting call shows while the server's own card has not reached this screen. It says only
 * what the call itself names and keeps the arguments behind Details; the server's card replaces it on arrival.
 */
export function standInApprovalCard({
  toolName,
  argsText,
  hostTarget,
}: {
  toolName: string;
  argsText: string | undefined;
  /** What the host itself saw at the call's target; the model cannot set it. */
  hostTarget: string | undefined;
}): SentinelApprovalCard {
  const args = parsedArgs(argsText);
  const wrapped = MCP_META_TOOLS.has(toolName) && isRecord(args) ? args : undefined;
  const innerName = typeof wrapped?.tool_name === 'string' ? wrapped.tool_name : undefined;
  const server = typeof wrapped?.mcp_server === 'string' && wrapped.mcp_server !== '' ? wrapped.mcp_server : null;
  const shownArgs = wrapped === undefined ? args : wrapped.input;
  const name = toolWords(innerName ?? toolName);
  return {
    plain_what: server === null ? `Allow the assistant to use "${name}"?` : `Allow "${name}" on ${server}?`,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: hostTarget ?? null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: argumentLines(shownArgs),
    destination_host: null,
    outbound_truncated: false,
    email: null,
    calendar_event: null,
    schedule: null,
    persona: null,
  };
}
