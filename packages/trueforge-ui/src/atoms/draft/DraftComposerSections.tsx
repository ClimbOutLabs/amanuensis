'use client';

import { useComposerInputActions } from '../../hooks/useComposerInputActions.js';
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

export function DraftComposerLeftSection({ disabled, isRunning, onAttach }: ComposerLeftSectionProps) {
  const shell = useOptionalShellMode();
  const DraftCompositeSelector = useSlot('DraftCompositeSelector');
  const DraftAgentConfigTrigger = useSlot('DraftAgentConfigTrigger');
  const DraftComposerActionsMenu = useSlot('DraftComposerActionsMenu');
  const compact = useCompactLayout();
  const isMobile = useIsMobile();
  const isBuilder = shell != null && shellIsCreateAgent(shell.mode);
  // The builder has no add-ons picker; its one `+` menu holds the agent settings on small screens.
  const inputActions = useComposerInputActions(onAttach);
  const builderActions = [
    ...(isBuilder && compact
      ? [
          {
            id: 'agent-config',
            label: 'Agent config',
            icon: 'sliders',
            onSelect: () => shell?.setAgentConfigOpen(true),
          },
        ]
      : []),
    ...inputActions,
  ];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {!isBuilder ? (
        <>
          <DraftCompositeSelector disabled={disabled} isRunning={isRunning} onAttach={onAttach} />
          <ActivePersonaIndicator disabled={disabled || isRunning} />
        </>
      ) : (
        <DraftComposerActionsMenu actions={builderActions} disabled={disabled || isRunning} />
      )}
      {isBuilder && !compact && isMobile ? <DraftAgentConfigTrigger disabled={disabled} isRunning={isRunning} /> : null}
    </div>
  );
}

/** The model control sits at the end of the bar, beside the mic; it is hidden while a turn runs. */
export function DraftComposerRightSection({ disabled, isRunning }: ComposerRightSectionProps) {
  const shell = useOptionalShellMode();
  const DraftModelSelector = useSlot('DraftModelSelector');
  const isBuilder = shell != null && shellIsCreateAgent(shell.mode);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {!isBuilder && !isRunning ? <DraftModelSelector disabled={disabled} isRunning={isRunning} /> : null}
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
