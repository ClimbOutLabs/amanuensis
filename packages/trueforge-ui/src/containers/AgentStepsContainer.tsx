'use client';

import { useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react';

import type { AgentStepsPhase } from '../atoms/adapters/AgentStepsCardAdapter.js';
import { useSlot } from '../theme/SlotsProvider.js';

export interface AgentStepsContainerProps {
  toolCount: number;
  thinkingCount: number;
  hasFinal: boolean;
  phase?: AgentStepsPhase;
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
      {children as ReactNode}
    </AgentStepsCard>
  );
}
