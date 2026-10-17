export type AgentHarnessErrorCode =
  | 'invalid_file_input'
  | 'invalid_send_input'
  | 'agent_sandbox_required'
  | 'tool_name_collision'
  | 'mcp_connection_failed'
  | 'capability_state_error'
  | 'compaction_summary_invalid';

/** The model provider answered a request with a failure. The message is for logs; the chat gets a plain one. */
export class ProviderRequestError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, options: { statusCode: number | undefined; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderRequestError';
    this.statusCode = options.statusCode;
  }
}

export class AgentHarnessError extends Error {
  constructor(
    readonly code: AgentHarnessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentHarnessError';
  }
}

export class InvalidFileInputError extends AgentHarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super('invalid_file_input', message, options);
    this.name = 'InvalidFileInputError';
  }
}

export class InvalidAgentSendInputError extends AgentHarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super('invalid_send_input', message, options);
    this.name = 'InvalidAgentSendInputError';
  }
}

export class AgentSandboxRequiredError extends AgentHarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super('agent_sandbox_required', message, options);
    this.name = 'AgentSandboxRequiredError';
  }
}

export class ToolNameCollisionError extends AgentHarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super('tool_name_collision', message, options);
    this.name = 'ToolNameCollisionError';
  }
}

/**
 * A remote MCP connection or tool call failed. Harness code can't throw the gateway's HTTPException,
 * so it throws this instead and carries `statusCode` (401 auth, 403 tool, 400 malformed value,
 * 422 well-formed but unprocessable, 502 transport) that the boundary turns back into an HTTP status.
 */
export class McpConnectionError extends AgentHarnessError {
  constructor(
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super('mcp_connection_failed', message, options);
    this.name = 'McpConnectionError';
  }
}

/**
 * The host rejected a tool before dispatch because the conversation's tool
 * policy does not admit it. This is distinct from a remote MCP server
 * returning HTTP 403 after an invocation crossed the execution boundary.
 */
export class ToolPolicyBlockedError extends McpConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 403, options);
    this.name = 'ToolPolicyBlockedError';
  }
}

/** A structured edit no longer targets the bytes shown when the user approved it. */
export class StructuredEditPreconditionBlockedError extends ToolPolicyBlockedError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StructuredEditPreconditionBlockedError';
  }
}

/** A previously selected durable implementation plan failed its final host admission check. */
export class ImplementationPlanAdmissionBlockedError extends ToolPolicyBlockedError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImplementationPlanAdmissionBlockedError';
  }
}

/** Tool preparation failed before the underlying provider received the call. */
export class ToolPreDispatchError extends McpConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 502, options);
    this.name = 'ToolPreDispatchError';
  }
}

/**
 * An MCP server's `auth.type: dcr` is unsatisfiable by configuration, not by a transient fault
 */
export class McpDcrConfigurationError extends McpConnectionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 422, options);
    this.name = 'McpDcrConfigurationError';
  }
}
