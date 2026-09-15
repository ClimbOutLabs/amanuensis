import type {
  BugReportApi,
  BugReportBundle,
  BugReportChat,
  BugReportChatMessage,
  BugReportError,
  BugReportTraceEvent,
  BugReportTurnTrace,
} from '@truefoundry/trueforge-ui';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function asUnknown(value: unknown): unknown {
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalCounts(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const counts: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number') {
      counts[key] = item;
    }
  }
  return counts;
}

function optionalTraceError(value: unknown): { code: string | null; message: string } | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') {
    return undefined;
  }
  return { code: typeof value.code === 'string' ? value.code : null, message: value.message };
}

/**
 * Tolerant field-by-field read: every field on a trace event is optional and independently
 * typed, so an unrecognized or malformed field is simply omitted rather than rejecting the
 * whole event — the same allowlist stance the server's redactor takes when assembling it.
 */
function parseTraceEvent(value: unknown): BugReportTraceEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('The bug-report response was invalid.');
  }
  const role = optionalString(value.role);
  const charCount = optionalNumber(value.char_count);
  const toolName = optionalString(value.tool_name);
  const effect = optionalString(value.effect);
  const outcome = optionalString(value.outcome);
  const durationMs = optionalNumber(value.duration_ms);
  const error = optionalTraceError(value.error);
  const counts = optionalCounts(value.counts);
  const atMs = optionalNumber(value.at_ms);
  const toolNames = isStringArray(value.tool_names) ? value.tool_names : undefined;
  const finishReason = optionalString(value.finish_reason);
  const exitCode = optionalNumber(value.exit_code);
  const intent = optionalString(value.intent);
  const outputTransform =
    value.output_transform === 'truncated' || value.output_transform === 'replaced'
      ? value.output_transform
      : undefined;
  return {
    type: value.type,
    ...(role !== undefined ? { role } : {}),
    ...(charCount !== undefined ? { char_count: charCount } : {}),
    ...(toolName !== undefined ? { tool_name: toolName } : {}),
    ...(effect !== undefined ? { effect } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(counts !== undefined ? { counts } : {}),
    ...(atMs !== undefined ? { at_ms: atMs } : {}),
    ...(toolNames !== undefined ? { tool_names: toolNames } : {}),
    ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(outputTransform !== undefined ? { output_transform: outputTransform } : {}),
  };
}

function parseTurnTrace(value: unknown): BugReportTurnTrace {
  if (!isRecord(value) || typeof value.turn_id !== 'string' || !Array.isArray(value.events)) {
    throw new Error('The bug-report response was invalid.');
  }
  return { turn_id: value.turn_id, events: value.events.map(parseTraceEvent) };
}

function parseError(value: unknown): BugReportError {
  if (
    !isRecord(value) ||
    typeof value.turn_id !== 'string' ||
    typeof value.event_type !== 'string' ||
    (value.code !== null && typeof value.code !== 'string') ||
    typeof value.message !== 'string'
  ) {
    throw new Error('The bug-report response was invalid.');
  }
  return { turn_id: value.turn_id, event_type: value.event_type, code: value.code, message: value.message };
}

/**
 * Structural, defensive parse — not a strict schema match — so a server that has evolved ahead
 * of this hand-written client (e.g. an additive field, before `@truefoundry/trueforge-sdk`
 * regenerates in CI) still reads successfully rather than throwing.
 */
function parseBundle(value: unknown): BugReportBundle {
  if (
    !isRecord(value) ||
    typeof value.schema_version !== 'number' ||
    typeof value.generated_at !== 'string' ||
    !isRecord(value.build) ||
    typeof value.build.version !== 'string' ||
    !isRecord(value.session) ||
    typeof value.session.id !== 'string' ||
    (value.session.agent_name !== null && typeof value.session.agent_name !== 'string') ||
    (value.session.model !== null && typeof value.session.model !== 'string') ||
    typeof value.session.created_at !== 'string' ||
    typeof value.user_description !== 'string' ||
    !Array.isArray(value.trace) ||
    !Array.isArray(value.recent_errors) ||
    !isRecord(value.config_flags) ||
    typeof value.config_flags.sandbox_enabled !== 'boolean' ||
    typeof value.config_flags.skill_enabled !== 'boolean' ||
    typeof value.config_flags.settings_enabled !== 'boolean' ||
    !isRecord(value.redaction) ||
    !isStringArray(value.redaction.stripped_fields) ||
    typeof value.redaction.notes !== 'string'
  ) {
    throw new Error('The bug-report response was invalid.');
  }
  const buildRef = optionalString(value.build.ref);
  const chat = parseChat(value.chat);
  return {
    schema_version: value.schema_version,
    generated_at: value.generated_at,
    build: { version: value.build.version, ...(buildRef !== undefined ? { ref: buildRef } : {}) },
    session: {
      id: value.session.id,
      agent_name: value.session.agent_name,
      model: value.session.model,
      created_at: value.session.created_at,
      connectors: isStringArray(value.session.connectors) ? value.session.connectors : [],
      skills: isStringArray(value.session.skills) ? value.session.skills : [],
      sandbox_enabled: value.session.sandbox_enabled === true,
    },
    user_description: value.user_description,
    summary: isStringArray(value.summary) ? value.summary : [],
    trace: value.trace.map(parseTurnTrace),
    recent_errors: value.recent_errors.map(parseError),
    config_flags: {
      sandbox_enabled: value.config_flags.sandbox_enabled,
      skill_enabled: value.config_flags.skill_enabled,
      settings_enabled: value.config_flags.settings_enabled,
    },
    redaction: { stripped_fields: value.redaction.stripped_fields, notes: value.redaction.notes },
    ...(chat === undefined ? {} : { chat }),
  };
}

/** The opt-in transcript, when the server carried one in a well-formed shape; otherwise left out. */
function parseChat(value: unknown): BugReportChat | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages) || typeof value.notes !== 'string') {
    return undefined;
  }
  const messages: BugReportChatMessage[] = [];
  for (const item of value.messages) {
    if (
      isRecord(item) &&
      typeof item.turn_id === 'string' &&
      (item.role === 'user' || item.role === 'assistant') &&
      typeof item.text === 'string'
    ) {
      messages.push({
        turn_id: item.turn_id,
        role: item.role,
        text: item.text,
        ...(item.truncated === true ? { truncated: true } : {}),
      });
    }
  }
  const omitted = value.omitted_messages;
  return {
    messages,
    notes: value.notes,
    ...(typeof omitted === 'number' && omitted > 0 ? { omitted_messages: omitted } : {}),
  };
}

function responseErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return typeof body.message === 'string' ? body.message : undefined;
}

async function readError(response: Response): Promise<Error> {
  const body = asUnknown(await response.json().catch(() => null));
  return new Error(responseErrorMessage(body) ?? `Request failed (${String(response.status)}).`);
}

export function createBugReportApi(fetcher: typeof fetch): BugReportApi {
  return {
    async generateBugReport({
      sessionId,
      description,
      includeChat,
    }: {
      sessionId: string;
      description: string;
      includeChat: boolean;
    }) {
      const response = await fetcher(`/api/v1/sessions/${encodeURIComponent(sessionId)}/bug-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, include_chat: includeChat }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
      const body = asUnknown(await response.json());
      if (!isRecord(body) || !Object.hasOwn(body, 'data')) {
        throw new Error('The bug-report response was invalid.');
      }
      return parseBundle(body.data);
    },
  };
}
