import { isRecord } from '../utils/sessionTimelineEvents.js';
import { MCP_META_TOOLS, parseMcpToolArgs } from '../utils/toolCallParsing.js';

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

/** Argument names that say who a message or invite goes to. */
const RECIPIENT_ARGUMENT =
  /^(to|cc|bcc|recipients?|send_?to|emails?|email_address(es)?|address(es)?|attendees|invitees)$/i;
/** Argument names that say where a request goes. */
const ADDRESS_ARGUMENT = /(url|uri|href|link|endpoint|domain|host)s?$/i;

function argumentRank(name: string): number {
  if (RECIPIENT_ARGUMENT.test(name)) return 0;
  if (ADDRESS_ARGUMENT.test(name)) return 1;
  return 2;
}

/**
 * One "name: value" line per argument, the way a server card lists what a connector gets. Who it goes to
 * and where it goes come first, so they are the first thing a person reads before answering.
 */
function argumentLines(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (!isRecord(args)) return typeof args === 'string' ? args : JSON.stringify(args);
  const lines = Object.entries(args)
    .map((entry, index) => ({ entry, index, rank: argumentRank(entry[0]) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ entry: [name, value] }) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return lines.length === 0 ? null : lines.join('\n');
}

/**
 * The card a waiting call shows while the server's own card has not reached this screen. It says only
 * what the call itself names, and the card shows those arguments open; the server's card replaces it on arrival.
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
  const mcp = MCP_META_TOOLS.has(toolName) ? parseMcpToolArgs(argsText) : undefined;
  // The arguments are model-written, so only string names are trusted.
  const innerName = typeof mcp?.innerToolName === 'string' ? mcp.innerToolName : undefined;
  const server = typeof mcp?.mcpServer === 'string' && mcp.mcpServer !== '' ? mcp.mcpServer : null;
  const shownArgs = mcp === undefined ? parsedArgs(argsText) : mcp.input;
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
    agent: null,
  };
}
