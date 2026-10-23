'use client';

import { shellIsCreateAgent, useOptionalShellMode } from '../../server/ShellModeContext.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { ActivePersonaIndicator } from '../ActivePersonaIndicator.js';
import {
  ComposerRightSection,
  type ComposerLeftSectionProps,
  type ComposerRightSectionProps,
} from '../ComposerSections.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import type { DraftComposerAction } from './DraftComposerActionsMenu.js';
import { DraftReasoningEffortSelector } from './DraftReasoningEffortSelector.js';

export function DraftComposerLeftSection({ disabled, isRunning, onAttach, workOnRepo }: ComposerLeftSectionProps) {
  const shell = useOptionalShellMode();
  const DraftCompositeSelector = useSlot('DraftCompositeSelector');
  const DraftAgentConfigTrigger = useSlot('DraftAgentConfigTrigger');
  const DraftComposerActionsMenu = useSlot('DraftComposerActionsMenu');
  const compact = useCompactLayout();
  const isMobile = useIsMobile();
  const isBuilder = shell != null && shellIsCreateAgent(shell.mode);
  const builderActions: DraftComposerAction[] = [
    ...(compact
      ? [
          {
            id: 'agent-config',
            label: 'Agent config',
            icon: 'sliders',
            onSelect: () => shell?.setAgentConfigOpen(true),
          },
        ]
      : []),
    ...(onAttach === undefined
      ? []
      : [{ id: 'attach', label: 'Attach a file', icon: 'paperclip', onSelect: onAttach }]),
    ...(workOnRepo ? [workOnRepo] : []),
  ];

  return (
    <div className="flex min-w-0 items-center gap-1">
      {!isBuilder ? (
        <>
          <DraftCompositeSelector
            disabled={disabled}
            isRunning={isRunning}
            onAttach={onAttach}
            workOnRepo={workOnRepo}
          />
          <ActivePersonaIndicator disabled={disabled || isRunning} />
        </>
      ) : (
        <DraftComposerActionsMenu actions={builderActions} disabled={disabled || isRunning} />
      )}
      {isBuilder && !compact && isMobile ? <DraftAgentConfigTrigger disabled={disabled} isRunning={isRunning} /> : null}
    </div>
  );
}

export function DraftComposerRightSection({ disabled, isRunning }: ComposerRightSectionProps) {
  const shell = useOptionalShellMode();
  const DraftModelSelector = useSlot('DraftModelSelector');
  const isBuilder = shell != null && shellIsCreateAgent(shell.mode);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* The model menu holds reasoning effort. The builder has no model menu, so it keeps the standalone control. */}
      {!isBuilder ? <DraftModelSelector disabled={disabled} isRunning={isRunning} /> : null}
      {isBuilder ? <DraftReasoningEffortSelector disabled={disabled} isRunning={isRunning} /> : null}
      <ComposerRightSection disabled={disabled} isRunning={isRunning} />
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    DraftComposerLeftSection: typeof DraftComposerLeftSection;
    DraftComposerRightSection: typeof DraftComposerRightSection;
  }
}
