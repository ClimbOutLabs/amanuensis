import type { TrueForgeAgentRuntimeConfig } from '../../server/types.js';

export type RuntimeConfigSummaryEntry = {
  label: string;
  value: string;
};

function enabledLabel(value: boolean | undefined, defaultValue: boolean): string {
  return (value ?? defaultValue) ? 'on' : 'off';
}

/** Primary for on / numeric values; destructive for off. */
export function runtimeConfigValueClassName(value: string): string {
  return value === 'off' ? 'text-failure-bg font-medium' : 'text-primary-button-bg font-medium';
}

export function runtimeConfigSummary(config?: TrueForgeAgentRuntimeConfig): RuntimeConfigSummaryEntry[] {
  const toolCallBudget = config?.taskState?.toolCallBudget;
  const budgetedTools = config?.taskState?.budgetedTools;
  return [
    { label: 'iteration limit', value: String(config?.iterationLimit ?? 100) },
    {
      label: 'research tool-call budget',
      value: toolCallBudget === undefined ? 'off' : String(toolCallBudget),
    },
    {
      label: 'budgeted tools',
      value: budgetedTools === undefined || budgetedTools.length === 0 ? '—' : budgetedTools.join(', '),
    },
    { label: 'sandbox', value: enabledLabel(config?.sandbox?.enabled, false) },
    { label: 'compaction', value: enabledLabel(config?.contextManagement?.compaction?.enabled, true) },
    {
      label: 'large tool response',
      value: enabledLabel(config?.contextManagement?.largeToolResponse?.enabled, true),
    },
    { label: 'dynamic sub-agents', value: enabledLabel(config?.dynamicSubAgents?.enabled, true) },
    { label: 'generative UI', value: enabledLabel(config?.generativeUi?.enabled, true) },
    { label: 'ask user questions', value: enabledLabel(config?.askUserQuestions?.enabled, true) },
  ];
}
