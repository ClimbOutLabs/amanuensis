import type { PartState } from '@assistant-ui/core/react';
import { isMapsToolName } from '@truefoundry/trueforge-core/core/permissions/mapsToolNames';

export type AgentStepPart = {
  type: PartState['type'];
  text?: string;
  toolName?: string;
  toolCallId?: string;
};

/** A contiguous run of parts folded into agent internals; `end` is exclusive. */
export interface AgentStepsRun {
  start: number;
  end: number;
  toolCount: number;
  thinkingCount: number;
}

export interface AgentStepsSplitResult {
  /** Folded runs in part order; every part outside them renders in the main flow. */
  runs: readonly AgentStepsRun[];
  hasFinal: boolean;
  toolCount: number;
  thinkingCount: number;
}

const SHORT_NARRATION_MAX_CHARS = 80;
const FINAL_HOLDBACK_CHARS = 500;

function isShortNarration(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < SHORT_NARRATION_MAX_CHARS && !trimmed.includes('\n');
}

/** A map is the answer the user asked to see, so its call never folds into agent internals. */
function isMapsCall(part: AgentStepPart): boolean {
  return part.type === 'tool-call' && part.toolName !== undefined && isMapsToolName(part.toolName);
}

function collectRuns({ parts, folded }: { parts: readonly AgentStepPart[]; folded: readonly boolean[] }) {
  const runs: AgentStepsRun[] = [];
  let current: AgentStepsRun | undefined;
  parts.forEach((part, index) => {
    if (!folded[index]) {
      current = undefined;
      return;
    }
    if (!current) {
      current = { start: index, end: index, toolCount: 0, thinkingCount: 0 };
      runs.push(current);
    }
    current.end = index + 1;
    if (part.type === 'tool-call') current.toolCount++;
    else if (part.type === 'reasoning') current.thinkingCount++;
  });
  return runs;
}

/**
 * Decides which parts fold into agent internals. Tool calls (except maps), reasoning and short narration fold;
 * substantive text before a tool call stays in the main flow. The trailing text run is the final
 * answer, held back while streaming until it is long enough to not flicker out of the steps.
 */
export function computeAgentStepsSplit(
  parts: readonly AgentStepPart[],
  isRunning: boolean,
  /** Parts that stay in the main flow whatever their kind, like a send receipt the person must be able to read. */
  keepVisible?: (part: AgentStepPart) => boolean,
): AgentStepsSplitResult {
  let trailingStart = parts.length;
  while (trailingStart > 0 && parts[trailingStart - 1]?.type === 'text') trailingStart--;

  const trailingTexts = parts.slice(trailingStart).map(part => part.text ?? '');
  const trailingChars = trailingTexts.reduce((sum, text) => sum + (text.trim() ? text.length : 0), 0);

  // Pure-text responses are always the final answer and must stream directly, not be held back.
  const hasAgentStepsBeforeTrailing = parts
    .slice(0, trailingStart)
    .some(
      part =>
        (part.type === 'tool-call' && !isMapsCall(part) && keepVisible?.(part) !== true) || part.type === 'reasoning',
    );

  const finalConfirmed =
    trailingChars > 0 && (!isRunning || trailingChars >= FINAL_HOLDBACK_CHARS || !hasAgentStepsBeforeTrailing);

  const folded = parts.map((part, index) => {
    if (index >= trailingStart) return !finalConfirmed;
    if (isMapsCall(part) || keepVisible?.(part) === true) return false;
    return part.type !== 'text' || isShortNarration(part.text ?? '');
  });

  // Narration with no step beside it has nothing to fold into; keep it visible rather than dropping it.
  for (const run of collectRuns({ parts, folded })) {
    if (run.toolCount + run.thinkingCount > 0) continue;
    for (let i = run.start; i < run.end; i++) {
      const part = parts[i];
      if (part?.type === 'text' && part.text?.trim()) folded[i] = false;
    }
  }

  const runs = collectRuns({ parts, folded });
  return {
    runs,
    hasFinal: finalConfirmed,
    toolCount: runs.reduce((sum, run) => sum + run.toolCount, 0),
    thinkingCount: runs.reduce((sum, run) => sum + run.thinkingCount, 0),
  };
}
