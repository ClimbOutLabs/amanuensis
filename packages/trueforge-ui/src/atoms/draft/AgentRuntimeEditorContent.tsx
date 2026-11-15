'use client';

import type { AgentSpec } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';

export type AgentRuntimeEditorContentProps = {
  spec: AgentSpec;
  sandboxAvailable: boolean;
  /** The picked model's size limit in tokens; null when a model is picked but its limit is unknown. */
  modelContextLength?: number | null;
  onChange: (spec: AgentSpec) => void;
};

export function AgentRuntimeEditorContent({
  spec,
  sandboxAvailable,
  modelContextLength,
  onChange,
}: AgentRuntimeEditorContentProps) {
  const AgentRuntimeConfigFields = useSlot('AgentRuntimeConfigFields');

  return (
    <div className="w-full p-5">
      <AgentRuntimeConfigFields
        value={spec.config ?? {}}
        sandboxAvailable={sandboxAvailable}
        hasSkills={(spec.skills?.length ?? 0) > 0}
        layout="detailed"
        modelContextLength={modelContextLength}
        onChange={config => onChange({ ...spec, config })}
      />
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentRuntimeEditorContent: typeof AgentRuntimeEditorContent;
  }
}
