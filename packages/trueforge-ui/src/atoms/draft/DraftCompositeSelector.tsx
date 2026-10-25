'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useOptionalWorkOnRepoPanel, useWorkOnRepoAvailable } from '../../containers/workOnRepoPanel.js';
import { useMCPAuth } from '../../hooks/useMcpAuth.js';
import { Icon } from '../../icons/Icon.js';
import { useOptionalCatalogServer, useServerCapabilities } from '../../server/ServerContext.js';
import { useOptionalShellMode, type SettingsSection } from '../../server/ShellModeContext.js';
import type { AgentSkill, ConnectorState } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { connectorDisplayName } from '../../utils/connectorNames.js';
import { cn } from '../lib/cn.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { auiInputClass } from '../lib/inputClasses.js';
import { useFitOnScreen } from '../lib/useFitOnScreen.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { BottomSheet } from '../primitives/BottomSheet.js';
import { Button } from '../primitives/Button.js';
import { CatalogLogo } from '../primitives/CatalogLogo.js';
import { Switch } from '../primitives/Switch.js';
import { readAgentCapabilities, withAgentCapabilities } from './agentCapabilities.js';
import { readSandboxEnabled, withSandboxEnabled } from './agentSandbox.js';
import { DraftCapabilitiesPanel } from './DraftCapabilitiesPanel.js';
import { DraftCatalogEmptyState } from './DraftCatalogEmptyState.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import type { DraftComposerAction } from './DraftComposerActionsMenu.js';
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
type AttachTab = 'connectors' | 'skills' | 'capabilities';

const TABS: { id: AttachTab; label: string; icon: string }[] = [
  { id: 'connectors', label: 'Connectors', icon: 'plug' },
  { id: 'skills', label: 'Skills', icon: 'lightbulb' },
  { id: 'capabilities', label: 'Capabilities', icon: 'wrench' },
];

const SPEC_FLUSH_MS = 300;

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

export type DraftCompositeSelectorProps = {
  disabled?: boolean;
  isRunning?: boolean;
  onAttach?: () => void;
};

/** The Add-ons picker's size before it is fitted to the screen, in CSS pixels. */
const PICKER_WIDTH = 448;
const PICKER_HEIGHT = 352;

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="text-text-secondary px-3 pt-2 pb-1 text-[0.75rem] font-normal">
      {label} ({count})
    </div>
  );
}

export function DraftCompositeSelector({ disabled, isRunning, onAttach }: DraftCompositeSelectorProps) {
  const DraftComposerActionsMenu = useSlot('DraftComposerActionsMenu');
  const { skills, connectors, connectorLogos, loading, ensureLoaded, refreshConnectors } = useDraftCatalog();
  const capabilities = useServerCapabilities();
  const settingsCatalog = useOptionalCatalogServer();
  const shell = useOptionalShellMode();
  const { agentSpec } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AttachTab>('connectors');
  const [query, setQuery] = useState('');
  // Section membership is snapped when the picker opens, so toggles don't jump rows mid-session.
  const [pinnedMcpIds, setPinnedMcpIds] = useState<Set<string>>(() => new Set());
  const [pinnedSkillIds, setPinnedSkillIds] = useState<Set<string>>(() => new Set());
  // Local working copy while open — flush to AgentSpec on debounce / close.
  const [localMcp, setLocalMcp] = useState<DraftMount[]>([]);
  const [localSkills, setLocalSkills] = useState<DraftMount[]>([]);
  const dirtyRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const localMcpRef = useRef(localMcp);
  const localSkillsRef = useRef(localSkills);
  localMcpRef.current = localMcp;
  localSkillsRef.current = localSkills;

  const containerRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const isMobile = useIsMobile();
  const compactLayout = useCompactLayout();
  const pickerStyle = useFitOnScreen({
    open: open && !isMobile && !compactLayout,
    anchorRef: containerRef,
    width: PICKER_WIDTH,
    height: PICKER_HEIGHT,
  });
  const skillsDisabled = capabilities?.skill.enabled !== true;
  const skillsDisabledReason = capabilities?.skill.reason;
  const needsSandbox = capabilities?.sandbox.enabled === false;
  const sandboxAvailable = capabilities?.sandbox.enabled === true;
  const settingsEnabled = capabilities?.settings?.enabled !== false;
  const canConfigureConnectors = settingsEnabled && settingsCatalog?.connectorCatalog != null;
  const canConfigureSkills = settingsEnabled && settingsCatalog?.skillCatalog != null;

  const specMcp = useMemo(() => draftMountsFromSpec(agentSpec?.mcpServers), [agentSpec?.mcpServers]);
  const specSkills = useMemo(() => draftMountsFromSpec(agentSpec?.skills), [agentSpec?.skills]);

  const selectedMcp = open ? localMcp : specMcp;
  const selectedSkills = open ? localSkills : specSkills;
  const selectedMcpIds = useMemo(() => new Set(selectedMcp.map(m => m.id)), [selectedMcp]);
  const hasValidModel = Boolean(agentSpec?.model?.name.trim());
  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current != null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const flushSpec = useCallback(() => {
    clearFlushTimer();
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    updateAgentSpec?.({
      mcpServers: localMcpRef.current,
      skills: localSkillsRef.current,
    });
  }, [clearFlushTimer, updateAgentSpec]);

  const scheduleFlush = useCallback(() => {
    clearFlushTimer();
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushSpec();
    }, SPEC_FLUSH_MS);
  }, [clearFlushTimer, flushSpec]);

  const setOpenAndFlush = useCallback(
    (next: boolean) => {
      if (!next) flushSpec();
      setOpen(next);
    },
    [flushSpec],
  );

  useEffect(() => {
    if (open) ensureLoaded();
  }, [open, ensureLoaded]);

  useEffect(() => {
    if (open && !hasValidModel) {
      setOpenAndFlush(false);
    }
  }, [hasValidModel, open, setOpenAndFlush]);

  useEffect(() => {
    if (!open) return;
    // Flush on pointer or keyboard focus leaving the picker so Save Agent (and
    // other outside actions) see the latest local connector/skill toggles.
    const handler = (e: Event) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenAndFlush(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenAndFlush(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('focusin', handler);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('focusin', handler);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setOpenAndFlush]);

  useEffect(() => () => clearFlushTimer(), [clearFlushTimer]);

  const catalogConnectors = useMemo(
    () => connectorsWithSelectedStubs({ connectors, selected: selectedMcp }),
    [connectors, selectedMcp],
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

  const pinnedSelectedConnectors = useMemo(
    () => filteredConnectors.filter(c => pinnedMcpIds.has(c.id)),
    [filteredConnectors, pinnedMcpIds],
  );
  const pinnedAvailableConnectors = useMemo(
    () => filteredConnectors.filter(c => !pinnedMcpIds.has(c.id)),
    [filteredConnectors, pinnedMcpIds],
  );
  const pinnedSelectedSkills = useMemo(
    () => filteredSkills.filter(s => pinnedSkillIds.has(skillFamilyId(s.id))),
    [filteredSkills, pinnedSkillIds],
  );
  const pinnedAvailableSkills = useMemo(
    () => filteredSkills.filter(s => !pinnedSkillIds.has(skillFamilyId(s.id))),
    [filteredSkills, pinnedSkillIds],
  );

  const toggleConnector = (connector: ConnectorState) => {
    setLocalMcp(prev =>
      prev.some(m => m.id === connector.id)
        ? prev.filter(m => m.id !== connector.id)
        : [...prev, { id: connector.id, name: connector.name }],
    );
    dirtyRef.current = true;
    scheduleFlush();
  };

  const toggleSkill = (skill: AgentSkill) => {
    const family = skillFamilyId(skill.id);
    const adding = !localSkillsRef.current.some(item => skillFamilyId(item.id) === family);
    setLocalSkills(previous =>
      previous.some(item => skillFamilyId(item.id) === family)
        ? previous.filter(item => skillFamilyId(item.id) !== family)
        : [...previous, { id: skill.id, name: skill.name }],
    );
    if (adding && capabilities?.sandbox.enabled === true) {
      updateAgentSpec?.({
        config: {
          ...agentSpec?.config,
          sandbox: { ...agentSpec?.config?.sandbox, enabled: true },
        },
      });
    }
    dirtyRef.current = true;
    scheduleFlush();
  };

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
        onToggle={() => toggleSkill(skill)}
      />
    );
  };

  const sandboxEnabled = readSandboxEnabled(agentSpec?.config);
  const sandboxDescription = !sandboxAvailable
    ? SANDBOX_UNAVAILABLE_REASON
    : selectedSkills.length > 0
      ? `${SANDBOX_DESCRIPTION} Turning this off clears attached skills.`
      : SANDBOX_DESCRIPTION;

  const toggleSandbox = () => {
    // Sandbox writes bypass the mount debounce, same as capability writes, folding
    // in any dirty local mounts so a pending connector/skill toggle is not lost.
    clearFlushTimer();
    const includeLocalMounts = dirtyRef.current;
    if (includeLocalMounts) dirtyRef.current = false;
    const nextEnabled = !sandboxEnabled;
    const clearingSkills = !nextEnabled && selectedSkills.length > 0;
    if (clearingSkills) setLocalSkills([]);
    updateAgentSpec?.({
      ...(includeLocalMounts ? { mcpServers: localMcpRef.current } : {}),
      ...(clearingSkills ? { skills: [] } : includeLocalMounts ? { skills: localSkillsRef.current } : {}),
      config: withSandboxEnabled(agentSpec?.config, nextEnabled),
    });
  };

  const openPicker = (nextTab?: AttachTab) => {
    if (nextTab != null) {
      setTab(nextTab);
      setQuery('');
    }
    if (open) return;
    setLocalMcp(specMcp);
    setLocalSkills(specSkills);
    dirtyRef.current = false;
    clearFlushTimer();
    setPinnedMcpIds(new Set(specMcp.map(m => m.id)));
    setPinnedSkillIds(new Set(specSkills.map(skill => skillFamilyId(skill.id))));
    setOpen(true);
  };

  const openSettings = (section: SettingsSection) => {
    setOpenAndFlush(false);
    setQuery('');
    shell?.setSettingsOpen(true, section);
  };

  const content = (
    <>
      <div className="flex shrink-0 border-b border-border">
        {TABS.map(t => {
          const count = t.id === 'connectors' ? selectedMcp.length : t.id === 'skills' ? selectedSkills.length : null;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={cn(
                'text-text-secondary flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium',
                active && 'text-primary-button-bg border-b-2 border-primary-button-bg',
              )}
              onClick={() => {
                setTab(t.id);
                setQuery('');
              }}
            >
              <Icon name={t.icon} className="size-3.5" />
              {t.label}
              {count != null && count > 0 ? (
                <span className="bg-secondary-bg rounded px-1 text-[0.625rem]">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {tab === 'capabilities' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <DraftCapabilitiesPanel
            value={readAgentCapabilities(agentSpec?.config)}
            disabled={disabled || isRunning}
            onChange={values => {
              // Capability writes bypass the mount debounce. Fold in any dirty
              // local mounts in the same update so a pending connector/skill
              // toggle is not overwritten by a config-only sync.
              clearFlushTimer();
              const includeLocalMounts = dirtyRef.current;
              if (includeLocalMounts) {
                dirtyRef.current = false;
              }
              updateAgentSpec?.({
                ...(includeLocalMounts ? { mcpServers: localMcpRef.current, skills: localSkillsRef.current } : {}),
                config: withAgentCapabilities({ config: agentSpec?.config, values }),
              });
            }}
          />
        </div>
      ) : (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder={tab === 'connectors' ? 'Search connectors...' : 'Search skills...'}
          />
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
                  onToggle={toggleSandbox}
                />
                {pinnedSelectedConnectors.length > 0 ? (
                  <>
                    <SectionHeading label="Selected" count={pinnedSelectedConnectors.length} />
                    {pinnedSelectedConnectors.map(c => (
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
                        onToggle={() => toggleConnector(c)}
                      />
                    ))}
                  </>
                ) : null}
                {pinnedAvailableConnectors.length > 0 ? (
                  <>
                    <SectionHeading label="Available" count={pinnedAvailableConnectors.length} />
                    {pinnedAvailableConnectors.map(c => (
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
                        onToggle={() => toggleConnector(c)}
                      />
                    ))}
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
                    onOpenSettings={shell && canConfigureConnectors ? () => openSettings('connectors') : undefined}
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
                      skills.length === 0 && shell && !needsSandbox && canConfigureSkills
                        ? () => openSettings('skills')
                        : undefined
                    }
                  />
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
  const workOnRepoPanel = useOptionalWorkOnRepoPanel();
  const workOnRepoAvailable = useWorkOnRepoAvailable();
  const menuActions: DraftComposerAction[] = [
    ...(onAttach === undefined ? [] : [{ id: 'attach', label: 'Attach files', icon: 'paperclip', onSelect: onAttach }]),
    ...(hasValidModel ? [{ id: 'add-ons', label: 'Add-ons', icon: 'wrench', onSelect: () => openPicker() }] : []),
    ...(workOnRepoPanel != null && workOnRepoAvailable
      ? [
          {
            id: 'work-on-repo',
            label: 'Work on a repo',
            icon: 'folder',
            onSelect: () => workOnRepoPanel.setPanelOpen(true),
          },
        ]
      : []),
  ];

  return (
    <div ref={containerRef} className="relative flex flex-wrap items-center">
      <DraftComposerActionsMenu actions={menuActions} disabled={disabled || isRunning} />

      {open && hasValidModel ? (
        isMobile || compactLayout ? (
          <BottomSheet id={menuId} open onOpenChange={setOpenAndFlush} aria-label="Add to composer">
            {content}
          </BottomSheet>
        ) : (
          <div
            id={menuId}
            role="dialog"
            aria-label="Add to composer"
            // Fitted to the screen: it opens on the side with more room and scrolls inside.
            style={
              pickerStyle === null
                ? { visibility: 'hidden' }
                : { ...pickerStyle, height: pickerStyle.maxHeight, overflowY: 'hidden' }
            }
            className="aui-popup-enter bg-card-bg text-text-primary z-50 flex flex-col overflow-hidden rounded-lg border border-border shadow-lg"
          >
            {content}
          </div>
        )
      ) : null}
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    CatalogRow: typeof CatalogRow;
    ConnectorConnectButton: typeof ConnectorConnectButton;
    DraftCompositeSelector: typeof DraftCompositeSelector;
  }
}
