'use client';

import { useMemo, useState } from 'react';

import type { SandboxToolCallCardProps } from '../atoms/SandboxToolCallCard.js';
import { useSlot } from '../theme/SlotsProvider.js';

export function SandboxToolCallContainer(
  props: Omit<SandboxToolCallCardProps, 'viewMode' | 'hasContent' | 'onViewModeChange'>,
) {
  const SandboxToolCallCard = useSlot('SandboxToolCallCard');
  const [viewMode, setViewMode] = useState<'terminal' | 'code'>('terminal');
  const terminalAvailable = Boolean(
    props.command || props.summary || props.resultText || props.resultJson || props.notices?.length,
  );
  const codeAvailable = Boolean(props.argsJson || props.resultJson);
  const effectiveViewMode = !terminalAvailable && codeAvailable ? 'code' : viewMode;
  const hasContent = useMemo(() => {
    if (effectiveViewMode === 'code') return codeAvailable;
    return terminalAvailable;
  }, [codeAvailable, effectiveViewMode, terminalAvailable]);

  return (
    <SandboxToolCallCard
      {...props}
      viewMode={effectiveViewMode}
      hasContent={hasContent}
      onViewModeChange={setViewMode}
    />
  );
}
