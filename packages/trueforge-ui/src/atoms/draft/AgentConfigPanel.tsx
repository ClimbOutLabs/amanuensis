'use client';

import { useState, type ReactNode } from 'react';

import { Icon } from '../../icons/Icon.js';
import type { AgentSkill, AgentSpec, ModelSelection } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { ResponsiveDropdownMenu } from '../primitives/ResponsiveDropdownMenu.js';
import { Tooltip } from '../primitives/Tooltip.js';
import type { AgentConfigEditor } from './AgentConfigEditors.js';
import { initialUserMessagesFromSpec } from './agentConfigMessages.js';
import {
  editableMountsFromSpec,
  enabledToolsFromMount,
  preloadFromMount,
  withPreload,
  type EditableMount,
} from './agentConfigMounts.js';
import { displayModelLabel, ProviderMark } from './DraftModelCatalogPanel.js';
import { modelParamSummary } from './modelParamsSummary.js';
import { runtimeConfigSummary, runtimeConfigValueClassName } from './runtimeConfigSummary.js';
import { skillFamilyId, skillVersion } from './SkillVersionSelector.js';

const DEFAULT_INSTRUCTIONS = 'For example: Each morning, read my new email and tell me which messages need a reply.';

export type AgentConfigPanelProps = {
  spec: AgentSpec;
  model?: ModelSelection;
  models: ModelSelection[];
  modelsLoading: boolean;
  modelsError: string | null;
  skills?: AgentSkill[];
  skillsAvailable: boolean;
  instructions: string;
  onOpenEditor: (editor: AgentConfigEditor) => void;
  onChange?: (spec: AgentSpec) => void;
  onClose?: () => void;
  disabled?: boolean;
};

function formatTokens(value: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function McpServerChip({
  item,
  onRemove,
  onTogglePreload,
}: {
  item: EditableMount;
  onRemove?: () => void;
  onTogglePreload?: () => void;
}) {
  const enabled = enabledToolsFromMount(item.value);
  const preload = preloadFromMount(item.value);
  const toolsLabel = enabled === 'all' ? 'All tools' : `${enabled.length} tools`;

  return (
    <span className="flex items-center overflow-hidden rounded-md border border-border text-xs">
      {onTogglePreload ? (
        <Tooltip
          side="bottom"
          dismissOnClick={false}
          triggerClassName="self-stretch"
          className="w-64 whitespace-normal p-3 text-left shadow-lg"
          content={
            <span className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between gap-3">
                <span className="font-semibold">Preload tools</span>
                <span className="text-primary-button-bg text-[0.625rem] font-semibold tracking-wide uppercase">
                  {preload ? 'ON' : 'OFF'}
                </span>
              </span>
              <span className="text-text-secondary text-xs leading-snug">
                Load tool details up front. When off, the agent fetches them as needed (uses less context upfront).
              </span>
            </span>
          }
        >
          <button
            type="button"
            aria-pressed={preload}
            aria-label={`Preload tools for ${item.name}`}
            className={cn(
              'flex h-full items-center justify-center border-r border-border px-1.5 transition-colors',
              preload
                ? 'bg-primary-button-bg text-primary-button-text'
                : 'text-text-secondary hover:bg-ghost-button-hover',
            )}
            onClick={event => {
              event.stopPropagation();
              onTogglePreload();
            }}
          >
            <Icon name="book-open" className="size-3.5" />
          </button>
        </Tooltip>
      ) : null}
      <span className="py-1 pl-2">{item.name}</span>
      <span className="text-text-secondary ml-1 py-1">{toolsLabel}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${item.name}`}
          className={auiButtonClass({
            variant: 'ghost',
            size: 'icon',
            className: 'mx-1 size-5',
          })}
          onClick={event => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="xmark" className="size-3" />
        </button>
      ) : (
        <span className="pr-2" />
      )}
    </span>
  );
}

function SkillChip({
  item,
  preloadAvailable,
  onRemove,
  onTogglePreload,
}: {
  item: EditableMount;
  preloadAvailable: boolean;
  onRemove?: () => void;
  onTogglePreload?: () => void;
}) {
  const preload = preloadFromMount(item.value);

  return (
    <span className="flex items-center overflow-hidden rounded-md border border-border text-xs">
      {preloadAvailable && onTogglePreload ? (
        <Tooltip
          side="bottom"
          dismissOnClick={false}
          triggerClassName="self-stretch"
          className="w-64 whitespace-normal p-3 text-left shadow-lg"
          content={
            <span className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between gap-3">
                <span className="font-semibold">Preload skill</span>
                <span className="text-primary-button-bg text-[0.625rem] font-semibold tracking-wide uppercase">
                  {preload ? 'ON' : 'OFF'}
                </span>
              </span>
              <span className="text-text-secondary text-xs leading-snug">
                Load the full skill up front. When off, the agent loads it as needed.
              </span>
            </span>
          }
        >
          <button
            type="button"
            aria-pressed={preload}
            aria-label={`Preload skill ${item.name}`}
            className={cn(
              'flex h-full items-center justify-center border-r border-border px-1.5 transition-colors',
              preload
                ? 'bg-primary-button-bg text-primary-button-text'
                : 'text-text-secondary hover:bg-ghost-button-hover',
            )}
            onClick={event => {
              event.stopPropagation();
              onTogglePreload();
            }}
          >
            <Icon name="book-open" className="size-3.5" />
          </button>
        </Tooltip>
      ) : null}
      <span className="py-1 pl-2">{item.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${item.name}`}
          className={auiButtonClass({
            variant: 'ghost',
            size: 'icon',
            className: 'mx-1 size-5',
          })}
          onClick={event => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="xmark" className="size-3" />
        </button>
      ) : (
        <span className="pr-2" />
      )}
    </span>
  );
}

export function AgentConfigSection({
  title,
  description,
  icon,
  actionIcon = 'pencil',
  actionLabel,
  showActionLabel = false,
  onEdit,
  children,
}: {
  title?: string;
  description?: string;
  icon?: string;
  actionIcon?: string;
  actionLabel?: string;
  /** Shows the action as a labelled button that is always on screen, not an icon that appears on hover. */
  showActionLabel?: boolean;
  onEdit?: () => void;
  children?: ReactNode;
}) {
  const action = actionLabel ?? `Edit ${title}`;

  return (
    <section
      className={cn('group border-b border-border px-4 py-4', onEdit ? 'cursor-pointer' : null)}
      role={onEdit ? 'button' : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onClick={onEdit}
      // Enter/Space activate the block like a native button. Keys aimed at nested
      // controls must pass through, or preventDefault here cancels their activation.
      onKeyDown={
        onEdit
          ? event => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onEdit();
            }
          : undefined
      }
    >
      {title && (
        <div className={cn('flex items-start justify-between gap-3', children ? 'mb-3' : null)}>
          <div className="flex min-w-0 items-start gap-2">
            {icon ? <Icon name={icon} className="text-text-secondary mt-0.5 size-4 shrink-0" /> : null}
            <div className="min-w-0">
              <h3 className="text-text-primary text-sm font-semibold">{title}</h3>
              {description ? <p className="text-text-secondary mt-0.5 text-xs">{description}</p> : null}
            </div>
          </div>
          {onEdit && showActionLabel ? (
            <button
              type="button"
              className={auiButtonClass({ variant: 'secondary', size: 'small', className: 'shrink-0' })}
              onClick={event => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Icon name={actionIcon} className="size-3.5" />
              {action}
            </button>
          ) : onEdit ? (
            <button
              type="button"
              aria-label={action}
              title={action}
              className={auiButtonClass({
                variant: 'ghost',
                size: 'icon',
                className: 'size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
              })}
              onClick={event => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Icon name={actionIcon} className="size-3.5" />
            </button>
          ) : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function AgentConfigPanel({
  spec,
  model,
  models,
  modelsLoading,
  modelsError,
  skills: catalogSkills = [],
  skillsAvailable,
  instructions,
  onOpenEditor,
  onChange,
  onClose,
  disabled = false,
}: AgentConfigPanelProps) {
  const Section = useSlot('AgentConfigSection');
  const AgentModelEditorContent = useSlot('AgentModelEditorContent');
  const AgentModelSettingsContent = useSlot('AgentModelSettingsContent');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSettingsMenuOpen, setModelSettingsMenuOpen] = useState(false);
  // The model and run settings are rarely changed, so they start folded away.
  const [moreOpen, setMoreOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const mcp = editableMountsFromSpec(spec.mcpServers);
  const skillMounts = editableMountsFromSpec(spec.skills);
  const modelParams = modelParamSummary(spec.model.params);
  const runtimeConfig = runtimeConfigSummary(spec.config);
  const instructionPreview = instructions.trim();
  const userMessageCount = initialUserMessagesFromSpec(spec).length;
  const modelInfo = [
    model?.properties.contextLength === undefined ? null : formatTokens(model.properties.contextLength),
  ].filter((value): value is string => value !== null);
  const modelInfoTitle = [
    model?.properties.contextLength === undefined
      ? null
      : `Context: ${model.properties.contextLength.toLocaleString()} tokens`,
    model?.properties.maxOutputTokens === undefined
      ? null
      : `Maximum output: ${model.properties.maxOutputTokens.toLocaleString()} tokens`,
  ]
    .filter((value): value is string => value !== null)
    .join('\n');

  return (
    <div className="bg-card-bg text-text-primary flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border bg-topbar-bg px-3 py-1.5">
        <Icon name="sliders" className="size-4" />
        <h2 className="text-sm font-semibold">Set up your agent</h2>
        <span className="min-w-0 flex-1" />
        {onClose ? (
          <button
            type="button"
            aria-label="Close agent setup"
            className={auiButtonClass({ variant: 'ghost', size: 'icon', className: 'size-8' })}
            onClick={onClose}
          >
            <Icon name="xmark" />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="What should it do?" description="Describe the job in your own words, as you would to a helper.">
          <button
            type="button"
            aria-label="Edit Instructions"
            disabled={disabled}
            className="border-border hover:bg-ghost-button-hover flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors"
            onClick={() => onOpenEditor('instructions')}
          >
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'line-clamp-3 whitespace-pre-wrap text-sm',
                  instructionPreview ? 'text-text-primary' : 'text-text-secondary',
                )}
              >
                {instructionPreview || DEFAULT_INSTRUCTIONS}
              </p>
              {userMessageCount > 0 ? (
                <p className="text-text-secondary mt-2 text-xs">
                  {userMessageCount} user {userMessageCount === 1 ? 'message' : 'messages'}
                </p>
              ) : null}
            </div>
            <Icon name="chevron-right" className="text-text-secondary size-4 shrink-0" />
          </button>
        </Section>

        <Section
          title="Connectors"
          description="The apps and services it can use, like your email or calendar."
          actionIcon="plus"
          actionLabel="Add a connector"
          showActionLabel
          onEdit={disabled ? undefined : () => onOpenEditor('mcp')}
        >
          {mcp.length ? (
            <div className="flex flex-wrap gap-1.5">
              {mcp.map(item => (
                <McpServerChip
                  key={item.id}
                  item={item}
                  onRemove={
                    onChange && !disabled
                      ? () =>
                          onChange({
                            ...spec,
                            mcpServers: mcp.filter(mount => mount.id !== item.id).map(mount => mount.value),
                          })
                      : undefined
                  }
                  onTogglePreload={
                    onChange && !disabled
                      ? () =>
                          onChange({
                            ...spec,
                            mcpServers: mcp.map(mount =>
                              mount.id === item.id
                                ? withPreload(mount.value, !preloadFromMount(mount.value))
                                : mount.value,
                            ),
                          })
                      : undefined
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-text-secondary text-xs">None yet.</p>
          )}
        </Section>

        <Section
          title="Skills"
          description="Extra know-how it can follow, like writing in your style."
          actionIcon="plus"
          actionLabel="Add a skill"
          showActionLabel
          onEdit={disabled ? undefined : () => onOpenEditor('skills')}
        >
          {!skillsAvailable ? (
            <p className="text-text-secondary text-xs">
              Skills need the sandbox. Turn it on in Settings, under Sandbox.
            </p>
          ) : skillMounts.length ? (
            <div className="flex flex-wrap gap-1.5">
              {skillMounts.map(item => {
                const preloadAvailable = catalogSkills.some(
                  skill => skillVersion(skill) !== undefined && skillFamilyId(skill.id) === skillFamilyId(item.id),
                );
                return (
                  <SkillChip
                    key={item.id}
                    item={item}
                    preloadAvailable={preloadAvailable}
                    onRemove={
                      onChange && !disabled
                        ? () =>
                            onChange({
                              ...spec,
                              skills: skillMounts.filter(mount => mount.id !== item.id).map(mount => mount.value),
                            })
                        : undefined
                    }
                    onTogglePreload={
                      preloadAvailable && onChange && !disabled
                        ? () =>
                            onChange({
                              ...spec,
                              skills: skillMounts.map(mount =>
                                mount.id === item.id
                                  ? withPreload(mount.value, !preloadFromMount(mount.value))
                                  : mount.value,
                              ),
                            })
                        : undefined
                    }
                  />
                );
              })}
            </div>
          ) : (
            <p className="text-text-secondary text-xs">None yet.</p>
          )}
        </Section>
        <section className="border-b border-border">
          <button
            type="button"
            aria-expanded={moreOpen}
            className="hover:bg-ghost-button-hover flex w-full items-center gap-2 px-4 py-4 text-left transition-colors"
            onClick={() => setMoreOpen(open => !open)}
          >
            <Icon
              name="chevron-right"
              className={cn('text-text-secondary size-4 shrink-0 transition-transform', moreOpen ? 'rotate-90' : null)}
            />
            <span className="min-w-0 flex-1">
              <span className="text-text-primary block text-sm font-semibold">More settings</span>
              <span className="text-text-secondary mt-0.5 block text-xs">
                The model it uses and how it runs. The usual choices work for most agents.
              </span>
            </span>
          </button>
        </section>

        {moreOpen ? (
          <>
            <Section title="Model" description="The AI that does the thinking.">
              <div className="flex w-full items-center gap-1">
                <ResponsiveDropdownMenu
                  open={modelMenuOpen}
                  onOpenChange={open => {
                    setModelMenuOpen(open);
                    if (!open) setModelQuery('');
                  }}
                  closeOnClick={false}
                  align="start"
                  sheetLabel="Select model"
                  containerClassName="flex min-w-0 flex-1"
                  className="w-[min(44rem,calc(100vw-2rem))] overflow-hidden p-0"
                  trigger={
                    <button
                      type="button"
                      aria-label="Edit Model"
                      title="Edit Model"
                      disabled={disabled}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 text-left transition-colors"
                    >
                      <ProviderMark
                        logo={model?.provider.logo}
                        label={model?.provider.name ?? spec.model.name}
                        className="size-4 text-[0.5rem]"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {displayModelLabel(spec.model.name)}
                      </span>
                      {modelInfo.length ? (
                        <span
                          title={modelInfoTitle}
                          className="text-text-secondary shrink-0 whitespace-nowrap text-[0.6875rem]"
                        >
                          {modelInfo.join(' · ')}
                        </span>
                      ) : null}
                      <Icon name="chevrons-up-down" className="text-text-secondary size-3.5 shrink-0" />
                    </button>
                  }
                >
                  <AgentModelEditorContent
                    spec={spec}
                    models={models}
                    loading={modelsLoading}
                    error={modelsError}
                    query={modelQuery}
                    onQueryChange={setModelQuery}
                    onChange={next => {
                      onChange?.(next);
                      setModelMenuOpen(false);
                      setModelQuery('');
                    }}
                  />
                </ResponsiveDropdownMenu>
                <ResponsiveDropdownMenu
                  open={modelSettingsMenuOpen}
                  onOpenChange={setModelSettingsMenuOpen}
                  closeOnClick={false}
                  align="start"
                  sheetLabel="Model settings"
                  className="w-[min(36rem,calc(100vw-2rem))] overflow-hidden p-0"
                  trigger={
                    <button
                      type="button"
                      aria-label="Model settings"
                      title="Model settings"
                      disabled={disabled}
                      className={auiButtonClass({
                        variant: 'ghost',
                        size: 'icon',
                        className: 'size-7 shrink-0',
                      })}
                    >
                      <Icon name="sliders" className="size-3.5" />
                    </button>
                  }
                >
                  <AgentModelSettingsContent spec={spec} model={model} onChange={next => onChange?.(next)} />
                </ResponsiveDropdownMenu>
              </div>
              <button
                type="button"
                disabled={disabled}
                aria-label="Edit model settings"
                // DropdownMenu dismisses on document mousedown; stop it so click can toggle closed without reopen.
                onMouseDown={event => event.stopPropagation()}
                onClick={() => setModelSettingsMenuOpen(open => !open)}
                className="mt-2 flex w-full cursor-pointer flex-col text-left disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="text-text-secondary flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs">
                  {modelParams.length ? (
                    modelParams.map(entry => (
                      <span key={entry.label} className="flex gap-1">
                        <span>{entry.label}:</span>
                        <span className="text-text-primary font-medium">{entry.value}</span>
                      </span>
                    ))
                  ) : (
                    <span>model settings: defaults</span>
                  )}
                </span>
              </button>
            </Section>

            <Section
              title="Run settings"
              description="Control how the agent runs and uses context."
              actionIcon="sliders"
              onEdit={disabled ? undefined : () => onOpenEditor('runtime')}
            >
              <dl className="text-text-secondary flex flex-wrap gap-x-3 gap-y-1 text-xs leading-relaxed">
                {runtimeConfig.map(entry => (
                  <div key={entry.label} className="flex gap-1">
                    <dt>{entry.label}:</dt>
                    <dd className={runtimeConfigValueClassName(entry.value)}>{entry.value}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentConfigPanel: typeof AgentConfigPanel;
    AgentConfigSection: typeof AgentConfigSection;
  }
}
