'use client';

import { useState, type FC } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import type { Tier2ActionKind } from './types.js';

export type Tier2EscalationToggleProps = {
  /** Exact Tier 2 action kind this toggle controls. */
  actionType: Tier2ActionKind;
  /** Whether the server currently escalates this kind to always ask. */
  escalated: boolean;
  onChange: (input: { actionType: Tier2ActionKind; escalated: boolean }) => Promise<void>;
  disabled?: boolean;
};

/**
 * "Always ask me" switch for one Tier 2 action kind. On by default; the checked
 * state always reflects the server settings, and flipping it writes through the user
 * settings API. Lives in the audit feed next to the kind it controls, never in
 * Settings.
 */
export const Tier2EscalationToggle: FC<Tier2EscalationToggleProps> = ({
  actionType,
  escalated,
  onChange,
  disabled = false,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onChange({ actionType, escalated: next });
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5">
        <Switch
          size="sm"
          checked={escalated}
          disabled={disabled || busy}
          onCheckedChange={handleChange}
          aria-label={`Always ask before ${actionType}`}
        />
        <span className="text-[0.6875rem] text-text-secondary">Always ask</span>
      </span>
      {error !== null && (
        <span className="text-[0.6875rem] text-failure-bg" role="alert">
          {error}
        </span>
      )}
    </span>
  );
};
