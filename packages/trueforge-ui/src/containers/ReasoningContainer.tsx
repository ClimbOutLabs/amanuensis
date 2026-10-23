'use client';

import { useAuiState } from '@assistant-ui/react';
import { useState } from 'react';

import { useSlot } from '../theme/SlotsProvider.js';
import type { ThreadGroupPart } from './ToolGroupContainer.js';

/** Shown only while agent details are on; the caller owns that check. */
export function ReasoningContainer({ group }: { group: ThreadGroupPart }) {
  const ReasoningCard = useSlot('ReasoningCard');
  const [expanded, setExpanded] = useState(false);
  const text = useAuiState(s =>
    group.indices
      .flatMap(index => {
        const part = s.message.parts[index];
        return part?.type === 'reasoning' && part.text.trim() !== '' ? [part.text] : [];
      })
      .join('\n\n'),
  );

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
      // The card stays closed until the person opens it; the text is never in the page before that.
      content={text}
      isStreaming={streaming}
      expanded={expanded}
      onToggle={() => setExpanded(open => !open)}
      headingText="Thinking…"
    />
  );
}
