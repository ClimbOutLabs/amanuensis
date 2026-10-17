'use client';

import { DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS } from '@truefoundry/trueforge-core/core/capabilities/builtins/tokenBudgetConstants';

import type { AgentInputTokensCompactionTrigger, TrueForgeAgentRuntimeConfig } from '../../server/types.js';
import { cn } from '../lib/cn.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { Switch } from '../primitives/Switch.js';
import { Tooltip } from '../primitives/Tooltip.js';

export type AgentRuntimeConfigFieldsProps = {
  value: TrueForgeAgentRuntimeConfig;
  sandboxAvailable: boolean;
  hasSkills: boolean;
  disabled?: boolean;
  showCapabilities?: boolean;
  layout?: 'compact' | 'detailed';
  /** Whether the selected model reports its context length; undefined while that is not known to the catalog. */
  modelContextLengthKnown?: boolean;
  onChange: (value: TrueForgeAgentRuntimeConfig) => void;
};

function parseIterationLimit(raw: string): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && Number.isFinite(parsed) ? Math.max(1, Math.min(1024, parsed)) : null;
}

function parsePositiveInteger(raw: string): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse the research tool-call budget field.
 * Returns `undefined` when the field is cleared (feature off),
 * `null` when the input is invalid (keep the previous value),
 * otherwise the clamped budget.
 */
function parseToolCallBudget(raw: string): number | null | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || !Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(1024, parsed));
}

function applyToolCallBudget(
  value: TrueForgeAgentRuntimeConfig,
  toolCallBudget: number | undefined,
): TrueForgeAgentRuntimeConfig {
  const budgetedTools = value.taskState?.budgetedTools;
  if (toolCallBudget === undefined && (budgetedTools ?? []).length === 0) {
    const { taskState: _dropped, ...rest } = value;
    void _dropped;
    return rest;
  }
  return {
    ...value,
    taskState: {
      ...(toolCallBudget === undefined ? {} : { toolCallBudget }),
      ...(budgetedTools === undefined ? {} : { budgetedTools }),
    },
  };
}

function parseBudgetedTools(raw: string): string[] {
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

function applyBudgetedTools(value: TrueForgeAgentRuntimeConfig, budgetedTools: string[]): TrueForgeAgentRuntimeConfig {
  const toolCallBudget = value.taskState?.toolCallBudget;
  if (budgetedTools.length === 0 && toolCallBudget === undefined) {
    const { taskState: _dropped, ...rest } = value;
    void _dropped;
    return rest;
  }
  return {
    ...value,
    taskState: {
      ...(toolCallBudget === undefined ? {} : { toolCallBudget }),
      ...(budgetedTools.length === 0 ? {} : { budgetedTools }),
    },
  };
}

const SANDBOX_UNAVAILABLE_HINT = 'The sandbox is not available on this server';

type RuntimeSwitchField = {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
  update: (enabled: boolean) => TrueForgeAgentRuntimeConfig;
};

export function AgentRuntimeConfigFields({
  value,
  sandboxAvailable,
  hasSkills,
  disabled = false,
  showCapabilities = true,
  layout = 'compact',
  modelContextLengthKnown,
  onChange,
}: AgentRuntimeConfigFieldsProps) {
  const capabilityFields: RuntimeSwitchField[] = [
    {
      label: 'Dynamic sub-agents',
      description: 'Allow the agent to delegate complex work to focused sub-agents.',
      checked: value.dynamicSubAgents?.enabled ?? true,
      update: enabled => ({ ...value, dynamicSubAgents: { enabled } }),
    },
    {
      label: 'Generative UI',
      description: 'Allow rich interactive UI blocks in agent responses.',
      checked: value.generativeUi?.enabled ?? true,
      update: enabled => ({ ...value, generativeUi: { enabled } }),
    },
    {
      label: 'Ask user questions',
      description: 'Allow the agent to pause and ask for clarification.',
      checked: value.askUserQuestions?.enabled ?? true,
      update: enabled => ({ ...value, askUserQuestions: { enabled } }),
    },
  ];
  const sandboxEnabled = value.sandbox?.enabled ?? false;
  const compactionEnabled = value.contextManagement?.compaction?.enabled ?? true;
  const sandboxField: RuntimeSwitchField = {
    label: 'Sandbox',
    description: 'Provide an isolated environment for code, files, and skills.',
    checked: sandboxEnabled,
    disabled: !sandboxAvailable || hasSkills,
    disabledTooltip: !sandboxAvailable
      ? SANDBOX_UNAVAILABLE_HINT
      : hasSkills
        ? 'Always on while skills are attached — remove them to turn it off'
        : undefined,
    update: enabled => ({ ...value, sandbox: { ...value.sandbox, enabled } }),
  };
  const fileDownloadsField: RuntimeSwitchField = {
    label: 'File downloads',
    description: 'Allow users to download files produced in the sandbox.',
    checked: value.sandbox?.fileDownloads ?? true,
    disabled: !sandboxAvailable || !sandboxEnabled,
    update: fileDownloads => ({
      ...value,
      sandbox: { ...value.sandbox, fileDownloads },
    }),
  };
  const compactionField: RuntimeSwitchField = {
    label: 'Context compaction',
    description: 'Summarize older turns as the context window fills.',
    checked: compactionEnabled,
    update: enabled => ({
      ...value,
      contextManagement: {
        ...value.contextManagement,
        compaction: { ...value.contextManagement?.compaction, enabled },
        largeToolResponse: value.contextManagement?.largeToolResponse ?? { enabled: true },
      },
    }),
  };
  const largeToolResponseField: RuntimeSwitchField = {
    label: 'Large tool response offloading',
    description: 'Move large tool output to the sandbox and retain a preview.',
    checked: value.contextManagement?.largeToolResponse?.enabled ?? true,
    disabled: !sandboxAvailable,
    disabledTooltip: !sandboxAvailable ? `Offloading needs a sandbox. ${SANDBOX_UNAVAILABLE_HINT}` : undefined,
    update: enabled => ({
      ...value,
      contextManagement: {
        ...value.contextManagement,
        compaction: value.contextManagement?.compaction ?? { enabled: true },
        largeToolResponse: { enabled },
      },
    }),
  };
  const runtimeFields = [sandboxField, fileDownloadsField, compactionField, largeToolResponseField];
  const compactionTrigger = value.contextManagement?.compaction?.trigger;
  const setCompactionTrigger = (trigger: AgentInputTokensCompactionTrigger | undefined) =>
    onChange({
      ...value,
      contextManagement: {
        ...value.contextManagement,
        compaction: { enabled: compactionEnabled, ...(trigger === undefined ? {} : { trigger }) },
        largeToolResponse: value.contextManagement?.largeToolResponse ?? { enabled: true },
      },
    });

  const switchField = ({
    field,
    className,
    wrapperClassName,
  }: {
    field: RuntimeSwitchField;
    className?: string;
    wrapperClassName?: string;
  }) => (
    <Tooltip
      key={field.label}
      content={field.disabledTooltip ?? ''}
      triggerClassName={cn('flex w-full min-w-0', wrapperClassName)}
    >
      <div className={cn('flex w-full', className ?? 'items-center justify-between gap-3 py-1.5')}>
        <span className="min-w-0">
          <span className={cn('text-text-primary text-xs', layout === 'detailed' && 'block font-medium')}>
            {field.label}
          </span>
          {layout === 'detailed' ? (
            <span className="text-text-secondary mt-0.5 block text-xs leading-snug">{field.description}</span>
          ) : null}
        </span>
        <Switch
          checked={field.checked}
          disabled={disabled || field.disabled}
          onCheckedChange={enabled => onChange(field.update(enabled))}
          aria-label={field.label}
        />
      </div>
    </Tooltip>
  );

  if (layout === 'detailed') {
    return (
      <div className="space-y-5">
        {showCapabilities ? (
          // Stack below `md` so narrow bottom sheets retain usable control widths.
          <div className="flex flex-col gap-3 border-b border-border pb-5 md:flex-row">
            {capabilityFields.map((field, index) =>
              switchField({
                field,
                className: 'items-start justify-between gap-3',
                wrapperClassName: cn(
                  'flex-1',
                  index < capabilityFields.length - 1 &&
                    'border-b border-border pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-3',
                ),
              }),
            )}
          </div>
        ) : null}
        <label className="flex items-center justify-between gap-4 border-b border-border py-3">
          <span>
            <span className="text-text-primary block text-sm font-medium">Iteration limit</span>
            <span className="text-text-secondary mt-0.5 block text-xs">
              Maximum agent-loop iterations for one turn.
            </span>
          </span>
          <input
            type="number"
            min={1}
            max={1024}
            disabled={disabled}
            value={value.iterationLimit ?? 100}
            className={auiInputClass('h-8 w-24 disabled:opacity-60')}
            onChange={event => {
              const iterationLimit = parseIterationLimit(event.target.value);
              if (iterationLimit !== null) onChange({ ...value, iterationLimit });
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-4 border-b border-border py-3">
          <span>
            <span className="text-text-primary block text-sm font-medium">Research tool-call budget</span>
            <span className="text-text-secondary mt-0.5 block text-xs">
              Host-owned research budget per turn. The agent banks findings into a structured scratchpad that survives
              context compaction; once the budget is spent, research tools are withheld and the agent must write its
              final answer from the banked findings. Empty disables it.
            </span>
          </span>
          <input
            type="number"
            min={1}
            max={1024}
            disabled={disabled}
            value={value.taskState?.toolCallBudget ?? ''}
            placeholder="Off"
            className={auiInputClass('h-8 w-24 disabled:opacity-60')}
            onChange={event => {
              const toolCallBudget = parseToolCallBudget(event.target.value);
              if (toolCallBudget !== null) onChange(applyToolCallBudget(value, toolCallBudget));
            }}
          />
        </label>
        <label className="flex items-center justify-between gap-4 border-b border-border py-3">
          <span>
            <span className="text-text-primary block text-sm font-medium">Budgeted tools</span>
            <span className="text-text-secondary mt-0.5 block text-xs">
              Comma-separated tool names charged against the budget and withheld once it is spent. `*` is a wildcard
              (e.g. `tavily*`). Required when the budget is set. `record_finding` is always exempt.
            </span>
          </span>
          <input
            type="text"
            disabled={disabled}
            value={(value.taskState?.budgetedTools ?? []).join(', ')}
            placeholder="tavily*"
            className={auiInputClass('h-8 w-48 disabled:opacity-60')}
            onChange={event => onChange(applyBudgetedTools(value, parseBudgetedTools(event.target.value)))}
          />
        </label>
        <div className="divide-y divide-border">
          <section className="py-3">
            {switchField({ field: sandboxField, className: 'items-center justify-between gap-4' })}
            <div className={`mt-3 border-l-2 border-primary-button-bg/50 pl-3 ${sandboxEnabled ? '' : 'opacity-50'}`}>
              {switchField({ field: fileDownloadsField, className: 'items-center justify-between gap-4' })}
            </div>
          </section>
          <section className="py-3">
            {switchField({ field: compactionField, className: 'items-center justify-between gap-4' })}
            <div
              className={`mt-3 border-l-2 border-primary-button-bg/50 pl-3 ${compactionEnabled ? '' : 'opacity-50'}`}
            >
              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="text-text-primary block text-xs font-medium">When to summarize long chats:</span>
                  <span className="text-text-secondary mt-0.5 block text-xs">
                    Aman summarizes the oldest part of a long chat so the model can keep reading it.
                  </span>
                </span>
                <select
                  aria-label="When to summarize long chats:"
                  disabled={disabled || !compactionEnabled}
                  value={compactionTrigger === undefined ? 'automatic' : 'set_size'}
                  className={auiInputClass('h-8 cursor-pointer py-1.5 disabled:opacity-60')}
                  onChange={event =>
                    setCompactionTrigger(
                      event.target.value === 'set_size'
                        ? { type: 'input_tokens', value: DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS }
                        : undefined,
                    )
                  }
                >
                  <option value="automatic">Automatic (recommended)</option>
                  <option value="set_size">At a set size</option>
                </select>
              </label>
              {compactionTrigger === undefined && modelContextLengthKnown === false ? (
                <p className="text-text-secondary mt-1 text-xs">
                  {"This model's size limit isn't known, so Aman uses a safe default."}
                </p>
              ) : null}
              {compactionTrigger === undefined ? null : (
                <label className="mt-2 flex items-center justify-between gap-4">
                  <span className="text-text-primary block text-xs font-medium">
                    Chat size to summarize at (in tokens)
                  </span>
                  <input
                    type="number"
                    min={1}
                    disabled={disabled || !compactionEnabled}
                    value={compactionTrigger.value}
                    className={auiInputClass('h-8 w-28 disabled:opacity-60')}
                    onChange={event => {
                      const threshold = parsePositiveInteger(event.target.value);
                      if (threshold === null) return;
                      setCompactionTrigger({ type: 'input_tokens', value: threshold });
                    }}
                  />
                </label>
              )}
            </div>
          </section>
          {switchField({ field: largeToolResponseField, className: 'items-center justify-between gap-4 py-3' })}
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="mb-2 block text-xs">
        <span className="text-text-secondary mb-1 block">Iteration limit</span>
        <input
          type="number"
          min={1}
          max={1024}
          disabled={disabled}
          value={value.iterationLimit ?? 100}
          className={auiInputClass('h-8 disabled:opacity-60')}
          onChange={event => {
            const iterationLimit = parseIterationLimit(event.target.value);
            if (iterationLimit !== null) onChange({ ...value, iterationLimit });
          }}
        />
      </label>
      <label className="mb-2 block text-xs">
        <span className="text-text-secondary mb-1 block">Research tool-call budget (empty = off)</span>
        <input
          type="number"
          min={1}
          max={1024}
          disabled={disabled}
          value={value.taskState?.toolCallBudget ?? ''}
          placeholder="Off"
          className={auiInputClass('h-8 disabled:opacity-60')}
          onChange={event => {
            const toolCallBudget = parseToolCallBudget(event.target.value);
            if (toolCallBudget !== null) onChange(applyToolCallBudget(value, toolCallBudget));
          }}
        />
      </label>
      <label className="mb-2 block text-xs">
        <span className="text-text-secondary mb-1 block">Budgeted tools (comma-separated, `*` = wildcard)</span>
        <input
          type="text"
          disabled={disabled}
          value={(value.taskState?.budgetedTools ?? []).join(', ')}
          placeholder="tavily*"
          className={auiInputClass('h-8 disabled:opacity-60')}
          onChange={event => onChange(applyBudgetedTools(value, parseBudgetedTools(event.target.value)))}
        />
      </label>
      {[...runtimeFields, ...(showCapabilities ? capabilityFields : [])].map(field => switchField({ field }))}
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentRuntimeConfigFields: typeof AgentRuntimeConfigFields;
  }
}
