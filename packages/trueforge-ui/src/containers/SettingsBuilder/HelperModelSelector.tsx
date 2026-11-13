'use client';

import { RoleModelPicker } from '@/atoms/draft/RoleModelPicker.js';
import { useToasterOptional } from '../ToasterContainer.js';
import type { MemoryNightlyState } from './memoryHelperSettings.js';

/** The helper model is kept on the server, so the background work that runs with no chat open follows it too. */
export function HelperModelSelector({ setting }: { setting: MemoryNightlyState }) {
  const toaster = useToasterOptional();
  return (
    <>
      <RoleModelPicker
        roleLabel="Helper"
        roleModelName={setting.helperModel ?? undefined}
        disabled={setting.saving || setting.enabled === null}
        onChoose={model => {
          void setting.setHelperModel(model ?? null).then(saved => {
            if (saved) toaster?.showSuccess({ title: 'Helper model saved' });
          });
        }}
      />
      {setting.error === null ? null : (
        <p className="mt-1.5 text-xs text-danger" role="alert">
          {setting.error}
        </p>
      )}
    </>
  );
}
