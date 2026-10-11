import type { ToolApprovalOption as AuiToolApprovalOption, ToolCallMessagePartProps } from '@assistant-ui/react';
import { parse as parsePartialJson } from 'partial-json';

import type { ToolCallStatus } from '../atoms/ToolCallCard.js';
import type { MapCardData, MapPin } from '../components/MapCard.js';

export type ApprovalOptionView = {
  id: string;
  label: string;
  isAllow: boolean;
  grants?: readonly string[];
  confirm?: {
    title?: string;
    description?: string;
  };
};

export type ToolDispositionView = {
  disposition: 'denied' | 'policy_blocked' | 'executed_ok' | 'executed_nonzero' | 'never_ran' | 'outcome_unknown';
  label: string;
  tone: 'success' | 'warning' | 'error' | 'muted';
  remediation?: string | undefined;
};

export type ToolOutputScreenView = {
  action: 'admitted' | 'withheld';
  label: string;
  tone: 'success' | 'warning';
  reason: string;
};

export const SUB_AGENT_TOOL_NAME = 'create_sub_agent';
export const ASK_USER_TOOL_NAME = 'ask_user_question';

/** Tool names that should be rendered as a sandbox execution card. */
export const SANDBOX_TOOL_NAMES = new Set([
  'exec',
  'sandbox_exec',
  'apply_patch',
  'replace_text',
  'write_file',
  'run_registered_command',
  'submit_implementation_plan',
]);

/** Tool names that render an embedded map card. */
export const MAPS_TOOL_NAMES = new Set(['render_map', 'render_route']);

/** MCP meta-tools that wrap actual tool calls. */
export const MCP_META_TOOLS = new Set(['call_tool', 'list_tools', 'get_tool_info']);

const APPROVAL_OPTION_DEFAULT_LABELS: Record<string, string> = {
  'allow-once': 'Allow once',
  'allow-always': 'Allow in this chat',
  'reject-once': 'Deny',
  'reject-always': 'Always deny',
};

const isAllowKind = (kind: string) => kind === 'allow-once' || kind === 'allow-always';

type JsonParseResult = { success: true; value: unknown; isPartial: boolean } | { success: false };

function parseJsonIncrementally(content: string): JsonParseResult {
  try {
    return { success: true, value: JSON.parse(content), isPartial: false };
  } catch {
    const trimmed = content.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return { success: false };

    try {
      return { success: true, value: parsePartialJson(content), isPartial: true };
    } catch {
      return { success: false };
    }
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function parseToolResultEnvelope(content: unknown): Record<string, unknown> | undefined {
  let parsed: unknown = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  if (
    !isUnknownRecord(parsed) ||
    parsed.schema_version !== 'tool.response.v2' ||
    !isUnknownRecord(parsed.outcome) ||
    !Object.hasOwn(parsed, 'result')
  ) {
    return undefined;
  }
  return parsed;
}

export function parseToolResultDisposition(content: unknown): ToolDispositionView | undefined {
  const envelope = parseToolResultEnvelope(content);
  const outcome = envelope?.outcome;
  if (!isUnknownRecord(outcome) || typeof outcome.disposition !== 'string') return undefined;
  const remediation =
    isUnknownRecord(outcome.remediation) && typeof outcome.remediation.message === 'string'
      ? outcome.remediation.message
      : undefined;
  switch (outcome.disposition) {
    case 'denied':
      return {
        disposition: outcome.disposition,
        label: 'Denied',
        tone: 'muted',
        ...(remediation ? { remediation } : {}),
      };
    case 'policy_blocked':
      return {
        disposition: outcome.disposition,
        label: 'Blocked by policy',
        tone: 'warning',
        ...(remediation ? { remediation } : {}),
      };
    case 'executed_ok':
      return {
        disposition: outcome.disposition,
        label: 'Completed',
        tone: 'success',
        ...(remediation ? { remediation } : {}),
      };
    case 'executed_nonzero':
      return {
        disposition: outcome.disposition,
        label: 'Execution failed',
        tone: 'error',
        ...(remediation ? { remediation } : {}),
      };
    case 'never_ran':
      return {
        disposition: outcome.disposition,
        label: 'Not run',
        tone: 'warning',
        ...(remediation ? { remediation } : {}),
      };
    case 'outcome_unknown':
      return {
        disposition: outcome.disposition,
        label: 'Outcome unknown',
        tone: 'warning',
        ...(remediation ? { remediation } : {}),
      };
    default:
      return undefined;
  }
}

const MAX_INLINE_FAILURE_REASON_LENGTH = 140;
const MAX_ERROR_TEXT_SEARCH_DEPTH = 8;

/**
 * Recursively hunts a parsed tool-result payload for the text a host or MCP server wrote to
 * explain a failure: an `error`, `error_summary`, or `message` field, unwrapping MCP content
 * arrays (`{ type: 'text', text: '...' }`) and re-parsing stringified JSON along the way. This is
 * what the model actually saw (see the `tool.response.v2` envelope's `result` field), so the text
 * surfaced here matches invariant I5.
 */
function findErrorText(value: unknown, depth: number): string | undefined {
  if (depth > MAX_ERROR_TEXT_SEARCH_DEPTH) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        const nested = findErrorText(JSON.parse(trimmed), depth + 1);
        if (nested) return nested;
      } catch {
        // Not JSON after all — fall through and use the raw string.
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findErrorText(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  if (isUnknownRecord(value)) {
    if ('error' in value) {
      const nested = findErrorText(value.error, depth + 1);
      if (nested) return nested;
    }
    if (typeof value.error_summary === 'string' && value.error_summary.trim()) return value.error_summary.trim();
    if (typeof value.text === 'string') {
      const nested = findErrorText(value.text, depth + 1);
      if (nested) return nested;
    }
    if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  }
  return undefined;
}

/**
 * The failure reason to show alongside a tool step's outcome badge: the host's own remediation
 * message when it set one (the rejection-contract text, or an `error_summary`-derived note), else
 * whatever error text the tool result itself carries. Returns undefined for a successful outcome,
 * or when no reason is present — callers must not invent one.
 */
export function getToolFailureReason(
  content: unknown,
  disposition: ToolDispositionView | undefined,
): string | undefined {
  if (disposition === undefined || disposition.disposition === 'executed_ok') return undefined;
  if (disposition.remediation) return disposition.remediation;
  const envelope = parseToolResultEnvelope(content);
  const visibleResult = envelope?.result ?? content;
  return findErrorText(visibleResult, 0);
}

/** Truncates a failure reason to a single inline line, for display next to the outcome label. */
export function truncateInlineReason(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  return firstLine.length > MAX_INLINE_FAILURE_REASON_LENGTH
    ? `${firstLine.slice(0, MAX_INLINE_FAILURE_REASON_LENGTH - 1)}…`
    : firstLine;
}

/**
 * Builds the outcome text shown next to a tool step: the disposition label alone when there is no
 * failure reason (or nothing has run yet), and the label plus the reason's first line otherwise —
 * so a step never shows a bare "Execution failed" when the tool result carries an explanation.
 */
export function buildOutcomeText(
  disposition: ToolDispositionView | undefined,
  failureReason: string | undefined,
): string | undefined {
  if (disposition === undefined) return undefined;
  if (!failureReason) return disposition.label;
  const inline = truncateInlineReason(failureReason);
  return inline ? `${disposition.label}: ${inline}` : disposition.label;
}

const TOOL_OUTPUT_SCREEN_FAILURE_CODES = new Set([
  'screen_not_configured',
  'screen_timeout',
  'screen_http_error',
  'screen_request_failed',
  'screen_response_too_large',
  'screen_malformed_response',
  'screen_response_unreadable',
  'screen_cancelled',
  'screen_internal_error',
]);

/** Extracts the host-owned prompt-injection decision without interpreting provider content. */
export function parseToolOutputScreen(content: unknown): ToolOutputScreenView | undefined {
  const outcome = parseToolResultEnvelope(content)?.outcome;
  if (!isUnknownRecord(outcome) || !isUnknownRecord(outcome.screen)) return undefined;
  const screen = outcome.screen;
  const scoreIsValid =
    typeof screen.score === 'number' && Number.isFinite(screen.score) && screen.score >= 0 && screen.score <= 1;

  if (
    screen.status === 'passed' &&
    screen.action === 'admitted' &&
    screen.reason_code === 'classifier_benign' &&
    scoreIsValid
  ) {
    return {
      action: 'admitted',
      label: 'Screened',
      tone: 'success',
      reason: 'No prompt injection detected',
    };
  }

  if (
    screen.status === 'flagged' &&
    screen.action === 'withheld' &&
    screen.reason_code === 'classifier_malicious' &&
    scoreIsValid
  ) {
    return {
      action: 'withheld',
      label: 'Content withheld',
      tone: 'warning',
      reason: 'Possible prompt injection detected',
    };
  }

  if (
    screen.status === 'unknown' &&
    screen.action === 'withheld' &&
    typeof screen.reason_code === 'string' &&
    TOOL_OUTPUT_SCREEN_FAILURE_CODES.has(screen.reason_code)
  ) {
    return {
      action: 'withheld',
      label: 'Content withheld',
      tone: 'warning',
      reason: 'Content screening was unavailable',
    };
  }

  return undefined;
}

export function parseAskUserQuestionArgs(argsText: string | undefined): {
  question?: string;
  options?: string[];
} {
  if (!argsText) return {};
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const question = typeof record.question === 'string' ? record.question : undefined;
    const options = Array.isArray(record.options)
      ? record.options.filter((item): item is string => typeof item === 'string')
      : undefined;
    return { question, options };
  } catch {
    return {};
  }
}

export function getAskUserAnswerResult(result: unknown): string | undefined {
  const visibleResult = parseToolResultEnvelope(result)?.result ?? result;
  if (visibleResult === undefined || visibleResult === null) return undefined;
  if (typeof visibleResult === 'string') {
    const trimmed = visibleResult.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isUnknownRecord(visibleResult)) {
    const content = visibleResult.content;
    if (typeof content === 'string' && content.trim()) {
      return content.trim();
    }
  }
  return undefined;
}

export function hasPendingAskUserResponse(part: Pick<ToolCallMessagePartProps, 'interrupt' | 'result'>): boolean {
  return part.interrupt != null && part.result === undefined;
}

export function hasPendingToolApproval(
  approval: { approved?: boolean; resolution?: 'cancelled' | 'expired' } | undefined,
) {
  return approval != null && approval.approved === undefined && approval.resolution === undefined;
}

/** The id of the single-use allow the server declared, if any. */
export function allowOnceOptionId(options: readonly AuiToolApprovalOption[] | undefined): string | undefined {
  return options?.find(option => option.kind === 'allow-once')?.id;
}

export function buildApprovalOptions(options: readonly AuiToolApprovalOption[] | undefined): ApprovalOptionView[] {
  const declared = options?.filter(o => Object.hasOwn(APPROVAL_OPTION_DEFAULT_LABELS, o.kind));
  if (declared && declared.length > 0) {
    const allow = declared.filter(o => isAllowKind(o.kind));
    const reject = declared.filter(o => !isAllowKind(o.kind));
    const mapped: ApprovalOptionView[] = [...allow, ...reject].map(o => ({
      id: o.id,
      label: o.label ?? APPROVAL_OPTION_DEFAULT_LABELS[o.kind] ?? o.id,
      isAllow: isAllowKind(o.kind),
      grants: o.grants,
      confirm: o.confirm != null ? (typeof o.confirm === 'object' ? o.confirm : {}) : undefined,
    }));
    if (reject.length === 0) {
      mapped.push({ id: '__deny', label: 'Deny', isAllow: false, confirm: {} });
    }
    return mapped;
  }
  return [
    { id: 'allow-once', label: 'Allow once', isAllow: true },
    { id: 'deny', label: 'Deny', isAllow: false, confirm: {} },
  ];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function toStatus(statusType: string | undefined): ToolCallStatus {
  if (statusType === 'complete') return 'success';
  if (statusType === 'incomplete') return 'error';
  return 'running';
}

function summarizePatch(patch: string): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files = lines.filter(line => line.startsWith('diff --git ')).length;
  const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return `${files} ${files === 1 ? 'file' : 'files'} · +${additions} −${deletions}`;
}

export function parseSandboxArgs(
  argsText: string | undefined,
  toolName?: string,
): {
  command?: string;
  intent?: string;
  summary?: string;
  argsJson?: string;
} {
  if (!argsText) return {};
  const parsed = parseJsonIncrementally(argsText);
  if (!parsed.success || !isUnknownRecord(parsed.value)) {
    return toolName === 'apply_patch' || toolName === 'replace_text' || toolName === 'write_file'
      ? {}
      : { argsJson: argsText };
  }

  const intent = typeof parsed.value.intent === 'string' ? parsed.value.intent : undefined;
  if (parsed.isPartial && (toolName === 'apply_patch' || toolName === 'replace_text' || toolName === 'write_file')) {
    return { intent };
  }

  let summary: string | undefined;
  if (toolName === 'apply_patch' && typeof parsed.value.patch === 'string') {
    summary = summarizePatch(parsed.value.patch);
  } else if (toolName === 'replace_text' && typeof parsed.value.path === 'string') {
    summary = `Edit ${parsed.value.path}`;
  } else if (toolName === 'write_file' && typeof parsed.value.path === 'string') {
    summary = `Write ${parsed.value.path}`;
  }

  return {
    command: typeof parsed.value.command === 'string' ? parsed.value.command : undefined,
    intent,
    summary,
    argsJson: parsed.isPartial ? argsText : JSON.stringify(parsed.value, null, 2),
  };
}

export function parseSandboxResult(result: string | undefined): {
  exitCode?: number | null;
  resultText?: string;
  resultJson?: string;
} {
  if (result === undefined) return {};
  const parsed = parseJsonIncrementally(result);
  if (!parsed.success || !isUnknownRecord(parsed.value)) return { resultText: result };

  const envelope = parseToolResultEnvelope(parsed.value);
  const visibleResult = envelope?.result ?? parsed.value;
  if (!isUnknownRecord(visibleResult)) return { resultText: String(visibleResult) };
  const response = isUnknownRecord(visibleResult.response) ? visibleResult.response : undefined;
  const exitCode = typeof response?.exitCode === 'number' ? response.exitCode : null;
  const resultText = typeof response?.result === 'string' ? response.result : undefined;
  return {
    exitCode,
    resultText,
    resultJson: parsed.isPartial ? result : JSON.stringify(visibleResult, null, 2),
  };
}

export function parseMcpToolArgs(argsText: string | undefined): {
  mcpServer?: string;
  innerToolName?: string;
  input?: unknown;
} {
  if (!argsText) return {};
  try {
    const parsed = JSON.parse(argsText) as {
      mcp_server?: string;
      tool_name?: string;
      input?: unknown;
    };
    return {
      mcpServer: parsed.mcp_server,
      innerToolName: parsed.tool_name,
      input: parsed.input,
    };
  } catch {
    return {};
  }
}

export function getJsonDisplayValue(content: string | undefined): {
  value: string;
  isJson: boolean;
} {
  if (!content?.trim()) return { value: '', isJson: false };
  const trimmed = content.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    return { value: content, isJson: false };
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return { value: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { value: content, isJson: false };
  }
}

export function getToolResultContent(content: unknown): {
  data: string;
  isJson: boolean;
} {
  try {
    if (!content) return { isJson: false, data: '' };

    const parsedResult = typeof content === 'string' && content.trim().startsWith('{') ? JSON.parse(content) : content;
    const envelope = parseToolResultEnvelope(parsedResult);
    const visibleResult = envelope?.result ?? parsedResult;

    if (isUnknownRecord(visibleResult) && Array.isArray(visibleResult.content)) {
      const firstContent = visibleResult.content[0];
      const text = isUnknownRecord(firstContent) && typeof firstContent.text === 'string' ? firstContent.text : '';
      const display = getJsonDisplayValue(typeof text === 'string' ? text : JSON.stringify(text));
      return { data: display.value, isJson: display.isJson };
    }
    const display = getJsonDisplayValue(
      typeof visibleResult === 'string' ? visibleResult : JSON.stringify(visibleResult),
    );
    return { data: display.value, isJson: display.isJson };
  } catch {
    return { data: String(content), isJson: false };
  }
}

export function resolveSubAgentMeta(part: ToolCallMessagePartProps): {
  agentName: string;
  instruction: string;
  stepCount: number;
} {
  const artifactSubAgent = (
    part as {
      artifact?: {
        subAgents?: Array<{
          title?: string;
          agentInfo?: { name?: string; input?: string };
        }>;
      };
    }
  ).artifact?.subAgents?.[0];
  const firstNested = part.messages?.[0];
  const subAgent = (
    firstNested?.metadata?.custom as { subAgent?: { title?: string; name?: string; input?: string } } | undefined
  )?.subAgent;
  return {
    agentName:
      subAgent?.title ??
      subAgent?.name ??
      artifactSubAgent?.title ??
      artifactSubAgent?.agentInfo?.name ??
      part.toolName,
    instruction: subAgent?.input ?? artifactSubAgent?.agentInfo?.input ?? '',
    stepCount: part.messages?.length ?? 0,
  };
}

export function mcpDisplayName(
  toolName: string,
  mcpServer: string | undefined,
  innerToolName: string | undefined,
): string {
  if (toolName === 'call_tool' && innerToolName) {
    return mcpServer ? `call_tool: ${innerToolName} (${mcpServer})` : `call_tool: ${innerToolName}`;
  }
  if (toolName === 'get_tool_info' && innerToolName && mcpServer) {
    return `get_tool_info: ${innerToolName} (${mcpServer})`;
  }
  return toolName;
}

export interface ParsedMapsResult {
  state: 'ready' | 'blocked' | 'unavailable';
  data: MapCardData | null;
  blockedMessage?: string;
}

interface MapsEndpoint {
  name: string;
  lat: number;
  lng: number;
}

function parseMapsEndpoint(value: unknown): MapsEndpoint | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const { resolved_name: name, lat, lng } = value;
  return typeof name === 'string' && typeof lat === 'number' && typeof lng === 'number'
    ? { name, lat, lng }
    : undefined;
}

/**
 * The visible payload of a maps tool result: the `tool.response.v2` envelope's `result` when the
 * host wrapped it (always, on the real wire), else the parsed JSON itself.
 */
function unwrapMapsPayload(resultString: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultString);
  } catch {
    return undefined;
  }
  const envelope = parseToolResultEnvelope(parsed);
  if (envelope === undefined) return parsed;
  const inner = envelope.result;
  if (typeof inner !== 'string') return inner;
  try {
    return JSON.parse(inner);
  } catch {
    return undefined;
  }
}

/**
 * Parse a render_map / render_route tool result into map card data.
 * Error results map to blocked/unavailable states; no card renders raw errors.
 */
export function parseMapsResult(resultString: string | undefined, toolName: string): ParsedMapsResult {
  if (resultString === undefined || resultString === '') {
    return { state: 'unavailable', data: null, blockedMessage: 'The map result is not available yet.' };
  }
  const body = unwrapMapsPayload(resultString);
  if (!isUnknownRecord(body)) {
    return { state: 'unavailable', data: null };
  }
  if (body.status === 'error') {
    const code = typeof body.code === 'string' ? body.code : 'service_unavailable';
    if (code === 'not_found') {
      return { state: 'unavailable', data: null, blockedMessage: 'The place could not be found.' };
    }
    if (code === 'no_route') {
      return { state: 'unavailable', data: null, blockedMessage: 'No driving route was found between the two places.' };
    }
    if (code === 'rate_limited') {
      return {
        state: 'blocked',
        data: null,
        blockedMessage: 'The map service rate limit was reached. Try again in a minute.',
      };
    }
    return { state: 'blocked', data: null, blockedMessage: 'The map service is unavailable right now.' };
  }
  if (body.status !== 'ok') {
    return { state: 'unavailable', data: null };
  }
  const attribution = typeof body.attribution === 'string' ? body.attribution : '© OpenStreetMap contributors';
  if (toolName === 'render_route') {
    const from = parseMapsEndpoint(body.from);
    const to = parseMapsEndpoint(body.to);
    if (from === undefined || to === undefined) {
      return { state: 'unavailable', data: null };
    }
    return {
      state: 'ready',
      data: {
        kind: 'route',
        lat: (from.lat + to.lat) / 2,
        lng: (from.lng + to.lng) / 2,
        zoom: 6,
        resolved_name: `${from.name} to ${to.name}`,
        address: null,
        pins: [],
        from_name: from.name,
        to_name: to.name,
        from_lat: from.lat,
        from_lng: from.lng,
        to_lat: to.lat,
        to_lng: to.lng,
        distance_km: typeof body.distance_km === 'number' ? body.distance_km : undefined,
        duration_min: typeof body.duration_min === 'number' ? body.duration_min : undefined,
        route_geometry: typeof body.route_geometry === 'string' ? body.route_geometry : undefined,
        attribution,
      },
    };
  }
  const pins: MapPin[] = [];
  if (Array.isArray(body.pins)) {
    for (const pin of body.pins) {
      if (!isUnknownRecord(pin)) continue;
      const { name, lat, lng } = pin;
      if (typeof name === 'string' && typeof lat === 'number' && typeof lng === 'number') {
        pins.push({ name, lat, lng });
      }
    }
  }
  return {
    state: 'ready',
    data: {
      kind: 'place',
      lat: typeof body.lat === 'number' ? body.lat : 0,
      lng: typeof body.lng === 'number' ? body.lng : 0,
      zoom: typeof body.zoom === 'number' ? body.zoom : 13,
      resolved_name: typeof body.resolved_name === 'string' ? body.resolved_name : '',
      address: typeof body.address === 'string' ? body.address : null,
      pins,
      attribution,
    },
  };
}
