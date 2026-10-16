import type { ThreadMessage } from '@assistant-ui/core';
import {
  RunCodeSetupFailureSchema,
  type RunCodeSetupFailure,
} from '@truefoundry/trueforge-core/core/sandbox/driver/RunCodeSchemas';

import { getToolResultContent } from './toolCallParsing.js';

const RUN_CODE_TOOL_NAME = 'run_code';

/** A part of any message, including those of a sub-agent's nested thread. */
export type MessagePart = ThreadMessage['content'][number];

/**
 * True for a call the host identified as the built-in run_code tool. The runtime records that from the
 * server's tool info, so an MCP tool that merely shares the name, or one the model describes, never
 * qualifies: its result is third-party text and must not be shown as a trusted notice with links.
 */
function isBuiltInRunCodeCall(artifact: unknown): boolean {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) return false;
  return Object.entries(artifact).some(([key, value]) => key === 'builtInToolName' && value === RUN_CODE_TOOL_NAME);
}

/**
 * Reads a run_code tool result and returns its failure when the sandbox could not start. Only the
 * result's own top-level fields count: output a program printed lives under `stdout`, so code
 * can never pass for a setup failure, and a non-zero exit is an `ok` result.
 */
export function getRunCodeSetupFailure(result: unknown): RunCodeSetupFailure | undefined {
  const { data, isJson } = getToolResultContent(result);
  if (!isJson) {
    return undefined;
  }
  try {
    const failure = RunCodeSetupFailureSchema.safeParse(JSON.parse(data));
    return failure.success ? failure.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Setup failures reported by built-in run_code calls in these parts, sub-agent threads included, in call
 * order. Repeated failures with the same text (a retried call) are reported once.
 */
export function collectRunCodeSetupFailures(parts: readonly MessagePart[]): RunCodeSetupFailure[] {
  const failures = new Map<string, RunCodeSetupFailure>();
  const visit = (current: readonly MessagePart[]): void => {
    for (const part of current) {
      if (part.type !== 'tool-call') {
        continue;
      }
      if (isBuiltInRunCodeCall(part.artifact)) {
        const failure = getRunCodeSetupFailure(part.result);
        if (failure !== undefined && !failures.has(failure.error)) {
          failures.set(failure.error, failure);
        }
      }
      for (const message of part.messages ?? []) {
        visit(message.content);
      }
    }
  };
  visit(parts);
  return [...failures.values()];
}
