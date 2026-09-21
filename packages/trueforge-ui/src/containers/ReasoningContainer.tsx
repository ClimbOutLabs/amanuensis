'use client';

import { useAuiState } from '@assistant-ui/react';

import { useSlot } from '../theme/SlotsProvider.js';
import type { ThreadGroupPart } from './ToolGroupContainer.js';

export function ReasoningContainer({ group }: { group: ThreadGroupPart }) {
  const ReasoningCard = useSlot('ReasoningCard');

  const streaming = useAuiState(s => {
    if (s.message.status?.type !== 'running') return false;
    const lastIndex = s.message.parts.length - 1;
    if (lastIndex < 0) return false;
    if (s.message.parts[lastIndex]?.type !== 'reasoning') return false;
    const lastGroupIndex = group.indices[group.indices.length - 1];
    const firstGroupIndex = group.indices[0];
    return (
      firstGroupIndex !== undefined &&
      lastGroupIndex !== undefined &&
      lastIndex >= firstGroupIndex &&
      lastIndex <= lastGroupIndex
    );
  });

  if (!streaming) return null;

  return (
    <ReasoningCard
      // Keep the provider contract, but never pass raw model reasoning to a
      // slot that could render it into accessible or DOM text.
      content=""
      isStreaming={streaming}
      headingText="Thinking…"
    />
  );
}
