'use client';

import type { FC } from 'react';

import type { SentinelApprovalPersona } from './types.js';

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-text-primary">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

/**
 * The persona a chat call adds. The instructions sit under Details because they shape every later answer,
 * so the person can read them before approving.
 */
export const PersonaDetails: FC<{ persona: SentinelApprovalPersona }> = ({ persona }) => (
  <div className="space-y-3 rounded border border-border bg-primary-bg px-3 py-2" data-role="persona">
    <div>
      <Line label="Name" value={persona.name} />
      <Line label="For" value={persona.description} />
      <Line label="Answers with" value={persona.model_name} />
    </div>
    <details>
      <summary className="cursor-pointer text-text-secondary">Details</summary>
      <div
        role="region"
        aria-label="Persona instructions"
        tabIndex={0}
        className="mt-2 max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
      >
        <p className="whitespace-pre-wrap break-words text-text-primary">{persona.instructions}</p>
      </div>
    </details>
  </div>
);
