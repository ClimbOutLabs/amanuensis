'use client';

import { useState, type FC } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { APPROVAL_CHOICES } from './approvalChoices.js';
import { TIER2_ACTION_LABELS, type Tier2ActionKind } from './types.js';

export type Tier2RelaxationToggleProps = {
  /** Exact Tier 2 action kind this toggle controls. */
  actionType: Tier2ActionKind;
  /** Whether the server currently lets this kind run without asking. */
  relaxed: boolean;
  onChange: (input: { actionType: Tier2ActionKind; relaxed: boolean }) => Promise<void>;
  disabled?: boolean;
};

/**
 * "Always allow" switch for one Tier 2 action kind. Off by default, so Tier 2
 * asks; the checked state always reflects the server settings, and flipping it writes
 * through the user settings API. Lives in the audit feed next to the kind it controls.
 */
export const Tier2RelaxationToggle: FC<Tier2RelaxationToggleProps> = ({
  actionType,
  relaxed,
  onChange,
  disabled = false,
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onChange({ actionType, relaxed: next });
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5" title={APPROVAL_CHOICES.alwaysAllow.hint}>
        <Switch
          size="sm"
          checked={relaxed}
          disabled={disabled || busy}
          onCheckedChange={handleChange}
          aria-label={`${APPROVAL_CHOICES.alwaysAllow.label}: ${TIER2_ACTION_LABELS[actionType]}`}
        />
        <span className="text-[0.6875rem] text-text-secondary">{APPROVAL_CHOICES.alwaysAllow.label}</span>
      </span>
      {error !== null && (
        <span className="text-[0.6875rem] text-failure-bg" role="alert">
          {error}
        </span>
      )}
    </span>
  );
};
