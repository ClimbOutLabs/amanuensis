'use client';

import { useTrueFoundryAgentSpec, useTrueFoundryUpdateAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { connectorOffKey } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';
import { useOptionalWorkOnRepoPanel, useWorkOnRepoAvailable } from '../../containers/workOnRepoPanel.js';
import { useComposerInputActions } from '../../hooks/useComposerInputActions.js';
import { Icon } from '../../icons/Icon.js';
import { useChatConnectorChoice } from '../../server/ChatConnectorChoiceContext.js';
import { useServerCapabilities } from '../../server/ServerContext.js';
import { useOptionalShellMode, type SettingsSection } from '../../server/ShellModeContext.js';
import type { AgentSkill, ConnectorState } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { cn } from '../lib/cn.js';
import { useCompactLayout } from '../lib/CompactLayoutContext.js';
import { useFitOnScreen } from '../lib/useFitOnScreen.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { BottomSheet } from '../primitives/BottomSheet.js';
import { readAgentCapabilities, withAgentCapabilities } from './agentCapabilities.js';
import { readSandboxEnabled, withSandboxEnabled } from './agentSandbox.js';
import { isDefaultOnConnector } from './defaultOnConnectors.js';
import { DraftCapabilitiesPanel } from './DraftCapabilitiesPanel.js';
import { useDraftCatalog } from './DraftCatalogProvider.js';
import type { DraftComposerAction } from './DraftComposerActionsMenu.js';
import { DraftToolPicker, draftMountsFromSpec, type DraftMount } from './DraftToolPicker.js';
import { skillFamilyId } from './SkillVersionSelector.js';
type AttachTab = 'connectors' | 'skills' | 'capabilities';

const TABS: { id: AttachTab; label: string; icon: string }[] = [
  { id: 'connectors', label: 'Connectors', icon: 'plug' },
  { id: 'skills', label: 'Skills', icon: 'lightbulb' },
  { id: 'capabilities', label: 'Capabilities', icon: 'wrench' },
];

const SPEC_FLUSH_MS = 300;

const CHOICE_NOT_SAVED_MESSAGE = 'Your change was not saved. Check your connection, then try the switch again.';

export type DraftCompositeSelectorProps = {
  disabled?: boolean;
  isRunning?: boolean;
  onAttach?: () => void;
};

/** The Add-ons picker's size before it is fitted to the screen, in CSS pixels. */
const PICKER_WIDTH = 448;
const PICKER_HEIGHT = 352;

export function DraftCompositeSelector({ disabled, isRunning, onAttach }: DraftCompositeSelectorProps) {
  const DraftComposerActionsMenu = useSlot('DraftComposerActionsMenu');
  const capabilities = useServerCapabilities();
  const shell = useOptionalShellMode();
  const { agentSpec, draftSessionId } = useTrueFoundryAgentSpec();
  const updateAgentSpec = useTrueFoundryUpdateAgentSpec();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AttachTab>('connectors');
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

  const { connectors } = useDraftCatalog();
  const { turnedOff, setTurnedOff } = useChatConnectorChoice(draftSessionId);
  const [choiceNotSaved, setChoiceNotSaved] = useState(false);
  // Email, Calendar and the search provider are on in every chat until the person turns one off.
  const defaultOnMounts = useMemo(
    () =>
      connectors
        .filter(connector => isDefaultOnConnector(connector) && !turnedOff.includes(connectorOffKey(connector.name)))
        .map(connector => ({ id: connector.id, name: connector.name })),
    [connectors, turnedOff],
  );
  const specMcp = useMemo(() => draftMountsFromSpec(agentSpec?.mcpServers), [agentSpec?.mcpServers]);
  const specSkills = useMemo(() => draftMountsFromSpec(agentSpec?.skills), [agentSpec?.skills]);

  const mountedMcp = open ? localMcp : specMcp;
  const selectedMcp = useMemo(
    () => [...mountedMcp, ...defaultOnMounts.filter(mount => !mountedMcp.some(item => item.id === mount.id))],
    [mountedMcp, defaultOnMounts],
  );
  const selectedSkills = open ? localSkills : specSkills;
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

  const toggleConnector = (connector: ConnectorState) => {
    const selected = selectedMcp.some(mount => mount.id === connector.id);
    const isDefaultOn = isDefaultOnConnector(connector);
    if (isDefaultOn) {
      // Default-on sources are never stored as mounts: only the off choice is kept for the chat.
      const offKey = connectorOffKey(connector.name);
      setChoiceNotSaved(false);
      setTurnedOff(selected ? [...turnedOff, offKey] : turnedOff.filter(key => key !== offKey)).catch(() => {
        // The hook already put the stored choice back; say so, so the switch is not read as a silent undo.
        setChoiceNotSaved(true);
      });
      // A mount the chat already lists is dropped too, or it would keep the source on.
      if (!selected || !localMcpRef.current.some(m => m.id === connector.id)) return;
    }
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

  const sandboxEnabled = readSandboxEnabled(agentSpec?.config);
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
    if (nextTab != null) setTab(nextTab);
    if (open) return;
    setLocalMcp(specMcp);
    setLocalSkills(specSkills);
    dirtyRef.current = false;
    clearFlushTimer();
    // A failed save from an earlier visit is stale once the list shows the stored choice again.
    setChoiceNotSaved(false);
    setOpen(true);
  };

  const openSettings = (section: SettingsSection) => {
    setOpenAndFlush(false);
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
              onClick={() => setTab(t.id)}
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
        <DraftToolPicker
          tab={tab}
          mcp={selectedMcp}
          skills={selectedSkills}
          sandboxEnabled={sandboxEnabled}
          onToggleConnector={toggleConnector}
          onToggleSkill={toggleSkill}
          onToggleSandbox={toggleSandbox}
          notice={choiceNotSaved ? CHOICE_NOT_SAVED_MESSAGE : undefined}
          onOpenSettings={openSettings}
        />
      )}
    </>
  );
  const inputActions = useComposerInputActions(onAttach);
  const workOnRepoPanel = useOptionalWorkOnRepoPanel();
  const workOnRepoAvailable = useWorkOnRepoAvailable();
  const menuActions: DraftComposerAction[] = [
    ...inputActions,
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
    DraftCompositeSelector: typeof DraftCompositeSelector;
  }
}
