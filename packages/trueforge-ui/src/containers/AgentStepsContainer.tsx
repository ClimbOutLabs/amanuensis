'use client';

import { useEffect, useRef, useState, type PropsWithChildren } from 'react';

import type { AgentStepsPhase } from '../atoms/adapters/AgentStepsCardAdapter.js';
import { useSlot } from '../theme/SlotsProvider.js';

export interface AgentStepsContainerProps {
  toolCount: number;
  thinkingCount: number;
  hasFinal: boolean;
  phase?: AgentStepsPhase;
  /**
   * Render the step rows without the accordion card. Used when an ancestor
   * (e.g. AgentInternalsDisclosure) already owns the summary row and its
   * show/hide toggle, so the trace does not end up nested inside two accordions.
   */
  bare?: boolean;
}

/**
 * Container for "Agent steps" section — groups reasoning, intermediate text, and tools
 * in a collapsible accordion that auto-collapses once final answer is confirmed.
 */
export function AgentStepsContainer({
  children,
  toolCount,
  thinkingCount,
  hasFinal,
  phase,
  bare = false,
}: PropsWithChildren<AgentStepsContainerProps>) {
  const AgentStepsCard = useSlot('AgentStepsCard');

  const [expanded, setExpanded] = useState(true);
  const collapsedByFinal = useRef(false);

  // Auto-collapse once when hasFinal becomes true (matches AgentTimeline behavior)
  useEffect(() => {
    if (hasFinal && phase !== 'waiting-for-approval' && !collapsedByFinal.current) {
      collapsedByFinal.current = true;
      setExpanded(false);
    }
  }, [hasFinal, phase]);

  if (bare) {
    return <div className="aui-agent-steps-bare flex flex-col gap-2">{children}</div>;
  }

  return (
    <AgentStepsCard
      toolCount={toolCount}
      thinkingCount={thinkingCount}
      phase={phase}
      expanded={phase === 'waiting-for-approval' || expanded}
      onToggle={() => {
        if (phase === 'waiting-for-approval') return;
        setExpanded(prev => !prev);
      }}
    >
      {children}
    </AgentStepsCard>
  );
}
