import { namedMailRecipients } from '../email/mailConnector/recipientList';
import { isMailDraftToolName } from '../email/mailConnector/toolContract';
import type { ToolResultDisposition } from '../events/schema';
import { EventType, ToolResultDispositionSchema } from '../events/schema';
import { isRecord } from '../util/records';
import type { ContextMessage } from './AgentThread.types';
import { isLLMContextMessage } from './contextUtils';
import { toolActionName } from './replyBudget';
import { turnBoundaryIndex } from './replyToolDumpRepair';

/** One tool call this turn and how it ended, read from the saved context. */
export interface TurnToolRun {
  toolName: string;
  args: string;
  disposition: ToolResultDisposition;
}

function dispositionOf(content: string): ToolResultDisposition | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['schema_version'] !== EventType.TOOL_RESPONSE_V2) {
    return undefined;
  }
  const outcome = parsed['outcome'];
  const disposition = isRecord(outcome) ? outcome['disposition'] : undefined;
  const result = ToolResultDispositionSchema.safeParse(disposition);
  return result.success ? result.data : undefined;
}

/** The tool calls since the person's latest message that have a result, in the order they were made. */
export function turnToolRuns(context: readonly ContextMessage[]): TurnToolRun[] {
  const calls = new Map<string, { toolName: string; args: string }>();
  const runs: TurnToolRun[] = [];
  for (let i = turnBoundaryIndex(context) + 1; i < context.length; i += 1) {
    const message = context[i];
    if (message === undefined || !isLLMContextMessage(message)) {
      continue;
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, { toolName: call.function.name, args: call.function.arguments });
      }
    } else if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id);
      const disposition = dispositionOf(message.content);
      if (call !== undefined && disposition !== undefined) {
        runs.push({ ...call, disposition });
      }
    }
  }
  return runs;
}

function draftRecipients(args: string): string[] {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? namedMailRecipients(parsed) : [];
  } catch {
    return [];
  }
}

const MAX_NAMED_RECIPIENTS = 3;

function recipientsPhrase(recipients: readonly string[]): string {
  const shown = recipients.slice(0, MAX_NAMED_RECIPIENTS).join(', ');
  const more = recipients.length - MAX_NAMED_RECIPIENTS;
  return more > 0 ? `${shown} and ${String(more)} more` : shown;
}

function runSentence(run: TurnToolRun): string {
  const action = toolActionName(run.toolName);
  switch (run.disposition) {
    case 'executed_ok': {
      if (isMailDraftToolName(run.toolName)) {
        const recipients = draftRecipients(run.args);
        return recipients.length === 0
          ? 'Saved the draft. Nothing was sent.'
          : `Saved the draft to ${recipientsPhrase(recipients)}. Nothing was sent.`;
      }
      return `Finished this step: ${action}.`;
    }
    case 'denied':
      return `Skipped, as you asked: ${action}.`;
    case 'policy_blocked':
      return `Not allowed here: ${action}.`;
    case 'never_ran':
      return `Did not start: ${action}.`;
    case 'executed_nonzero':
      return `This step failed: ${action}.`;
    case 'outcome_unknown':
      return `Not sure this step worked: ${action}.`;
  }
}

/**
 * The host's own last words when the model gave none, built only from how the tools ended. A repeat that
 * was skipped is left out when the same call already worked, since it adds nothing for the person.
 */
export function silentTurnEndLine(runs: readonly TurnToolRun[]): string {
  const worked = new Set(
    runs.filter(run => run.disposition === 'executed_ok').map(run => `${run.toolName}:${run.args}`),
  );
  const sentences = runs
    .filter(run => run.disposition === 'executed_ok' || !worked.has(`${run.toolName}:${run.args}`))
    .map(runSentence);
  return [...new Set(sentences)].join(' ');
}
