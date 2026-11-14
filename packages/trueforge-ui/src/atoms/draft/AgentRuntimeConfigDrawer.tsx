'use client';

import type { AgentSpec } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { SideDrawer } from '../primitives/SideDrawer.js';

export type AgentRuntimeConfigDrawerProps = {
  open: boolean;
  spec: AgentSpec;
  sandboxAvailable: boolean;
  /** The picked model's size limit in tokens; null when a model is picked but its limit is unknown. */
  modelContextLength?: number | null;
  onChange: (spec: AgentSpec) => void;
  onClose: () => void;
};

export function AgentRuntimeConfigDrawer({
  open,
  spec,
  sandboxAvailable,
  modelContextLength,
  onChange,
  onClose,
}: AgentRuntimeConfigDrawerProps) {
  const AgentRuntimeEditorContent = useSlot('AgentRuntimeEditorContent');

  return (
    <SideDrawer
      open={open}
      onOpenChange={nextOpen => !nextOpen && onClose()}
      title="Run settings"
      description="Control execution, sandbox, and context behavior."
      anchor="right"
      size="xl"
      className="md:w-3xl"
      aria-label="Edit Run settings"
    >
      <AgentRuntimeEditorContent
        spec={spec}
        sandboxAvailable={sandboxAvailable}
        modelContextLength={modelContextLength}
        onChange={onChange}
      />
    </SideDrawer>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentRuntimeConfigDrawer: typeof AgentRuntimeConfigDrawer;
  }
}
