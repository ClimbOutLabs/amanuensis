'use client';

import { useState, type FC } from 'react';

import { Button } from '../atoms/primitives/Button.js';
import { CenteredModal } from '../atoms/primitives/CenteredModal.js';
import { APPROVAL_CHOICES } from './approvalChoices.js';

export type AlwaysAllowToolControlProps = {
  /** Says which call the standing grant covers, in the confirm step. */
  description: string;
  size: 'small' | 'large';
  className?: string;
  disabled?: boolean;
  /** Runs only after the owner confirms; a cancel never calls it. */
  onConfirm: () => void;
};

/** "Always allow this tool" and its confirm step, shared by every approval card that offers it. */
export const AlwaysAllowToolControl: FC<AlwaysAllowToolControlProps> = ({
  description,
  size,
  className,
  disabled = false,
  onConfirm,
}) => {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        size={size}
        title={APPROVAL_CHOICES.alwaysAllowTool.hint}
        onClick={() => {
          setConfirming(true);
        }}
        disabled={disabled}
        className={className}
      >
        {APPROVAL_CHOICES.alwaysAllowTool.label}
      </Button>
      <CenteredModal
        open={confirming}
        onOpenChange={open => {
          if (!open) setConfirming(false);
        }}
        title="Always allow this tool?"
        description={description}
        contentSized
        aria-label="Confirm always allowing this tool"
      >
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="font-sans text-sm leading-relaxed text-text-primary">
            You can remove this later in connector settings.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={() => {
                setConfirming(false);
              }}
              data-testid="always-allow-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="small"
              onClick={() => {
                setConfirming(false);
                onConfirm();
              }}
              data-testid="always-allow-confirm"
            >
              Confirm
            </Button>
          </div>
        </div>
      </CenteredModal>
    </>
  );
};
