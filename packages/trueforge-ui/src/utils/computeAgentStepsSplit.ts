import type { PartState } from '@assistant-ui/core/react';
import { isMapsToolName } from '@truefoundry/trueforge-core/core/permissions/mapsToolNames';

export type AgentStepPart = {
  type: PartState['type'];
  text?: string;
  toolName?: string;
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
 * Decides which parts fold into agent internals. Only tool calls (except maps), reasoning and
 * whitespace-only text fold; every part with visible text stays in the main flow as it streams,
 * so text never moves between folded and unfolded once it has content.
 */
export function computeAgentStepsSplit(parts: readonly AgentStepPart[]): AgentStepsSplitResult {
  let trailingStart = parts.length;
  while (trailingStart > 0 && parts[trailingStart - 1]?.type === 'text') trailingStart--;
  const hasFinal = parts.slice(trailingStart).some(part => (part.text ?? '').trim() !== '');

  const folded = parts.map(part => {
    if (isMapsCall(part)) return false;
    return part.type !== 'text' || (part.text ?? '').trim() === '';
  });

  const runs = collectRuns({ parts, folded });
  return {
    runs,
    hasFinal,
    toolCount: runs.reduce((sum, run) => sum + run.toolCount, 0),
    thinkingCount: runs.reduce((sum, run) => sum + run.thinkingCount, 0),
  };
}
