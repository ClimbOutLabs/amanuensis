'use client';

import type { FC } from 'react';

import type { SentinelApprovalAgent } from './types.js';

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-words text-text-primary">
      <span className="text-text-secondary">{label}: </span>
      {value}
    </p>
  );
}

function namesOrNone(names: readonly string[]): string {
  return names.length === 0 ? 'None' : names.join(', ');
}

/**
 * The agent a chat call saves. The instructions sit under Details because they shape every later run,
 * so the person can read them before approving.
 */
export const AgentDetails: FC<{ agent: SentinelApprovalAgent }> = ({ agent }) => (
  <div className="space-y-3 rounded border border-border bg-primary-bg px-3 py-2" data-role="agent">
    <div>
      <Line label="Name" value={agent.name} />
      <Line label="For" value={agent.description} />
      <Line label="Answers with" value={agent.model_name} />
      <Line label="Connectors" value={namesOrNone(agent.connectors)} />
      <Line label="Skills" value={namesOrNone(agent.skills)} />
      <Line label="Sandbox" value={agent.sandbox_enabled ? 'On' : 'Off'} />
    </div>
    <details>
      <summary className="cursor-pointer text-text-secondary">Details</summary>
      <div
        role="region"
        aria-label="Agent instructions"
        tabIndex={0}
        className="mt-2 max-h-60 overflow-auto rounded border border-border bg-card-bg px-3 py-2"
      >
        <p className="whitespace-pre-wrap break-words text-text-primary">{agent.instructions}</p>
      </div>
    </details>
  </div>
);
