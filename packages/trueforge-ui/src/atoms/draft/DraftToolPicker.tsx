'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useMCPAuth } from '../../hooks/useMcpAuth.js';
import { Icon } from '../../icons/Icon.js';
import { useOptionalCatalogServer, useServerCapabilities } from '../../server/ServerContext.js';
import { useOptionalShellMode, type SettingsSection } from '../../server/ShellModeContext.js';
import type { AgentSkill, ConnectorState } from '../../server/types.js';
import { connectorDisplayName } from '../../utils/connectorNames.js';
import { cn } from '../lib/cn.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { Button } from '../primitives/Button.js';
import { CatalogLogo } from '../primitives/CatalogLogo.js';
import { Switch } from '../primitives/Switch.js';
import { DraftCatalogEmptyState } from './DraftCatalogEmptyState.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import { connectorsWithSelectedStubs } from './mcpConnectorStubs.js';
import { skillFamilyId, skillRepoName } from './SkillVersionSelector.js';

/** Catalog-backed mount shape used by the draft picker (runtime mounts stay opaque). */
export type DraftMount = { id: string; name: string; preload?: boolean };

/**
 * Harness wire mounts are name-keyed (`{ name }` only). Catalog rows use
 * `id === name`, so missing ids hydrate from name — otherwise save/load drops
 * mounts from the picker and the next flush can wipe them from the spec.
 */
export function draftMountsFromSpec(value: unknown): DraftMount[] {
  if (!Array.isArray(value)) return [];
  const mounts: DraftMount[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const name = Reflect.get(item, 'name');
    if (typeof name !== 'string') continue;
    const id = Reflect.get(item, 'id');
    const displayName = Reflect.get(item, 'display_name');
    const preload = Reflect.get(item, 'preload');
    mounts.push({
      id: typeof id === 'string' ? id : name,
      name: typeof displayName === 'string' ? displayName : name,
      ...(typeof preload === 'boolean' ? { preload } : {}),
    });
  }
  return mounts;
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border',
        checked
          ? 'border-primary-button-bg bg-primary-button-bg text-primary-button-text'
          : 'border-input-border bg-input-box-bg',
      )}
      aria-hidden
    >
      {checked ? <Icon name="check" className="size-3" /> : null}
    </span>
  );
}

export function CatalogRow({
  title,
  description,
  badge,
  logo,
  fallbackIcon,
  checked,
  disabled = false,
  onToggle,
  onActivate,
  action,
}: {
  title: string;
  description?: string;
  badge?: ReactNode;
  /** Catalog logo URL; when absent, `fallbackIcon` (or the title initial) is shown. */
  logo?: string | undefined;
  fallbackIcon?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onActivate?: () => void;
  action?: ReactNode;
}) {
  const content = (
    <>
      <span
        className="bg-secondary-bg text-text-secondary mt-0.5 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded border border-border text-xs font-semibold"
        aria-hidden
      >
        {logo ? (
          <CatalogLogo src={logo} alt={title} className="size-4" />
        ) : fallbackIcon ? (
          <Icon name={fallbackIcon} className="text-text-primary size-4" />
        ) : (
          title.charAt(0).toUpperCase()
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-text-primary truncate text-sm font-medium">{title}</span>
          {badge}
        </span>
        {description ? <span className="text-text-secondary line-clamp-1 text-xs">{description}</span> : null}
      </span>
    </>
  );

  if (action || onActivate) {
    return (
      <div
        role="menuitemcheckbox"
        aria-checked={checked}
        tabIndex={0}
        className="hover:bg-ghost-button-hover flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left"
        onClick={onActivate ?? onToggle}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          (onActivate ?? onToggle)();
        }}
      >
        {content}
        <span
          className="shrink-0"
          onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
        >
          {action}
        </span>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`${checked ? 'Deselect' : 'Select'} ${title}`}
          disabled={disabled}
          className="shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={event => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <Checkbox checked={checked} />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      className="hover:bg-ghost-button-hover flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      onClick={onToggle}
    >
      {content}
      {disabled ? <Icon name="lock" className="text-text-secondary size-3" /> : <Checkbox checked={checked} />}
    </button>
  );
}

const SANDBOX_DESCRIPTION = 'Give the agent an isolated workspace to run code, read documents and use skills.';
const SANDBOX_UNAVAILABLE_REASON = 'The sandbox is not available on this server';

function SandboxToggleRow({
  enabled,
  disabled,
  description,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  description: string;
  onToggle: () => void;
}) {
  return (
    <div className="flex w-full items-start gap-2 rounded-md border-b border-border px-2 py-2 text-left">
      <span className="bg-secondary-bg text-text-secondary mt-0.5 flex size-7 shrink-0 items-center justify-center rounded text-xs font-semibold">
        S
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-text-primary block truncate text-sm font-medium">Sandbox</span>
        <span className="text-text-secondary line-clamp-2 text-xs">{description}</span>
      </span>
      <Switch
        checked={enabled}
        aria-label="Sandbox"
        disabled={disabled}
        className="mt-0.5"
        onCheckedChange={onToggle}
      />
    </div>
  );
}

export function isUnauthenticatedDcrConnector(connector: ConnectorState): boolean {
  const auth = Reflect.get(connector, 'auth');
  return (
    connector.authenticated === false &&
    typeof auth === 'object' &&
    auth !== null &&
    Reflect.get(auth, 'type') === 'dcr'
  );
}

export function ConnectorConnectButton({
  connector,
  onConnected,
}: {
  connector: ConnectorState;
  onConnected: () => Promise<void>;
}) {
  const { handleAuthorize, isOAuthLoading } = useMCPAuth();

  return (
    <Button.Secondary
      type="button"
      aria-label={`Connect ${connectorDisplayName(connector.name)}`}
      disabled={isOAuthLoading}
      size="small"
      onKeyDown={event => {
        event.stopPropagation();
      }}
      onClick={event => {
        event.stopPropagation();
        void handleAuthorize(connector.id, isSuccess => {
          if (isSuccess) void onConnected();
        });
      }}
    >
      {isOAuthLoading ? 'Connecting...' : 'Connect'}
    </Button.Secondary>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="relative mx-3 my-2 block">
      <Icon
        name="search"
        className="text-text-secondary pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
      />
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={auiInputClass('h-8 bg-secondary-bg py-1 pr-2 pl-7 dark:bg-primary-bg')}
      />
    </label>
  );
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="text-text-secondary px-3 pt-2 pb-1 text-xs font-normal">
      {label} ({count})
    </div>
  );
}

export type DraftToolPickerProps = {
  tab: 'connectors' | 'skills';
  mcp: readonly DraftMount[];
  skills: readonly DraftMount[];
  sandboxEnabled: boolean;
  onToggleConnector: (connector: ConnectorState) => void;
  onToggleSkill: (skill: AgentSkill) => void;
  onToggleSandbox: () => void;
  /** A plain line shown above the connector list, for example when a switch could not be saved. */
  notice?: string | undefined;
  /** Absent, the empty states do not offer a link to Settings. */
  onOpenSettings?: (section: SettingsSection) => void;
};

/**
 * The connector, skill and sandbox choices, shared by the chat's Add-ons picker and a schedule's Tools section.
 * It holds no selection itself: the owner decides where a toggle is saved and which connectors count as selected,
 * so the chat can pass the ones it ticks by default while a schedule passes only what it lists. Mount it only while
 * it is shown, so the Selected group is snapped from the selection at that moment and rows do not jump.
 */
export function DraftToolPicker({
  tab,
  mcp,
  skills: selectedSkills,
  sandboxEnabled,
  onToggleConnector,
  onToggleSkill,
  onToggleSandbox,
  notice,
  onOpenSettings,
}: DraftToolPickerProps) {
  const { skills, connectors, connectorLogos, loading, ensureLoaded, refreshConnectors } = useDraftCatalog();
  const capabilities = useServerCapabilities();
  const settingsCatalog = useOptionalCatalogServer();
  const shell = useOptionalShellMode();
  const [query, setQuery] = useState('');
  const [pinnedMcpIds] = useState(() => new Set(mcp.map(mount => mount.id)));
  const [pinnedSkillIds] = useState(() => new Set(selectedSkills.map(skill => skillFamilyId(skill.id))));

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  useEffect(() => {
    setQuery('');
  }, [tab]);

  const skillsDisabled = capabilities?.skill.enabled !== true;
  const skillsDisabledReason = capabilities?.skill.reason;
  const needsSandbox = capabilities?.sandbox.enabled === false;
  const sandboxAvailable = capabilities?.sandbox.enabled === true;
  const settingsEnabled = capabilities?.settings?.enabled !== false;
  const canConfigureConnectors = settingsEnabled && settingsCatalog?.connectorCatalog != null;
  const canConfigureSkills = settingsEnabled && settingsCatalog?.skillCatalog != null;
  const selectedMcpIds = useMemo(() => new Set(mcp.map(mount => mount.id)), [mcp]);

  const catalogConnectors = useMemo(
    () => connectorsWithSelectedStubs({ connectors, selected: mcp }),
    [connectors, mcp],
  );

  const filteredConnectors = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? catalogConnectors.filter(
          c => c.name.toLowerCase().includes(needle) || (c.description?.toLowerCase().includes(needle) ?? false),
        )
      : catalogConnectors;
    return [...matches].sort(
      (left, right) => Number(isUnauthenticatedDcrConnector(left)) - Number(isUnauthenticatedDcrConnector(right)),
    );
  }, [catalogConnectors, query]);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter(
      skill =>
        skill.name.toLowerCase().includes(needle) ||
        (skillRepoName(skill)?.toLowerCase().includes(needle) ?? false) ||
        (skill.description?.toLowerCase().includes(needle) ?? false),
    );
  }, [skills, query]);

  const pinnedSelectedConnectors = filteredConnectors.filter(c => pinnedMcpIds.has(c.id));
  const pinnedAvailableConnectors = filteredConnectors.filter(c => !pinnedMcpIds.has(c.id));
  const pinnedSelectedSkills = filteredSkills.filter(s => pinnedSkillIds.has(skillFamilyId(s.id)));
  const pinnedAvailableSkills = filteredSkills.filter(s => !pinnedSkillIds.has(skillFamilyId(s.id)));

  const renderConnector = (c: ConnectorState) => (
    <CatalogRow
      key={c.id}
      title={connectorDisplayName(c.name)}
      logo={connectorLogos[c.name]}
      fallbackIcon="mcp-server"
      checked={selectedMcpIds.has(c.id)}
      action={
        isUnauthenticatedDcrConnector(c) ? (
          <ConnectorConnectButton connector={c} onConnected={refreshConnectors} />
        ) : undefined
      }
      onToggle={() => onToggleConnector(c)}
    />
  );

  const renderSkill = (skill: AgentSkill) => {
    const selected = selectedSkills.find(mount => skillFamilyId(mount.id) === skillFamilyId(skill.id));
    const repoName = skillRepoName(skill);
    return (
      <CatalogRow
        key={skill.id}
        title={skill.name}
        description={skill.description}
        badge={
          repoName === undefined ? undefined : (
            <span className="bg-primary-button-bg/10 text-primary-button-bg shrink-0 rounded-full px-1.5 py-0.5 text-[0.625rem]">
              {repoName}
            </span>
          )
        }
        checked={selected !== undefined}
        disabled={skillsDisabled && selected === undefined}
        onToggle={() => onToggleSkill(skill)}
      />
    );
  };

  const sandboxDescription = !sandboxAvailable
    ? SANDBOX_UNAVAILABLE_REASON
    : selectedSkills.length > 0
      ? `${SANDBOX_DESCRIPTION} Turning this off clears attached skills.`
      : SANDBOX_DESCRIPTION;

  return (
    <>
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={tab === 'connectors' ? 'Search connectors...' : 'Search skills...'}
      />
      {tab === 'connectors' && notice !== undefined ? (
        <p role="alert" className="text-failure-bg mx-3 mb-2 text-xs">
          {notice}
        </p>
      ) : null}
      {tab === 'skills' && skillsDisabled && skillsDisabledReason ? (
        <div
          role="status"
          className="border-primary-button-bg/30 bg-primary-button-bg/5 text-text-primary mx-3 mb-2 flex items-center gap-2 rounded-lg border p-3"
        >
          <Icon name="lock" className="text-primary-button-bg size-3 shrink-0" />
          <span className="text-xs leading-none">{skillsDisabledReason}</span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {tab === 'connectors' ? (
          <>
            <SandboxToggleRow
              enabled={sandboxEnabled}
              disabled={!sandboxAvailable && !sandboxEnabled}
              description={sandboxDescription}
              onToggle={onToggleSandbox}
            />
            {pinnedSelectedConnectors.length > 0 ? (
              <>
                <SectionHeading label="Selected" count={pinnedSelectedConnectors.length} />
                {pinnedSelectedConnectors.map(renderConnector)}
              </>
            ) : null}
            {pinnedAvailableConnectors.length > 0 ? (
              <>
                <SectionHeading label="Available" count={pinnedAvailableConnectors.length} />
                {pinnedAvailableConnectors.map(renderConnector)}
              </>
            ) : null}
            {filteredConnectors.length === 0 && connectors.length > 0 ? (
              <DraftCatalogEmptyState loading={loading} emptyLabel="No connectors" settingsTarget="Connectors" />
            ) : null}
            {connectors.length === 0 ? (
              <DraftCatalogEmptyState
                loading={loading}
                emptyLabel="No connectors"
                settingsTarget="Connectors"
                onOpenSettings={
                  shell && canConfigureConnectors && onOpenSettings ? () => onOpenSettings('connectors') : undefined
                }
              />
            ) : null}
          </>
        ) : (
          <>
            {pinnedSelectedSkills.length > 0 ? (
              <>
                <SectionHeading label="Selected" count={pinnedSelectedSkills.length} />
                {pinnedSelectedSkills.map(renderSkill)}
              </>
            ) : null}
            {pinnedAvailableSkills.length > 0 ? (
              <>
                <SectionHeading label="Available" count={pinnedAvailableSkills.length} />
                {pinnedAvailableSkills.map(renderSkill)}
              </>
            ) : null}
            {filteredSkills.length === 0 ? (
              <DraftCatalogEmptyState
                loading={loading}
                emptyLabel="No skills"
                settingsTarget="Skills"
                onOpenSettings={
                  skills.length === 0 && shell && !needsSandbox && canConfigureSkills && onOpenSettings
                    ? () => onOpenSettings('skills')
                    : undefined
                }
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    CatalogRow: typeof CatalogRow;
    ConnectorConnectButton: typeof ConnectorConnectButton;
  }
}
