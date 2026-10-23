'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { useDraftCatalog } from '@/atoms/draft/DraftCatalogProvider.js';
import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { useCompactLayout } from '@/atoms/lib/CompactLayoutContext.js';
import { tablistTargetIndex } from '@/atoms/lib/tablistKeys.js';
import { Spinner } from '@/atoms/primitives/Spinner.js';
import { AmanFirstRunGuide } from '@/components/AmanFirstRunGuide.js';
import { useOptionalAmanSetup } from '@/components/AmanSetupContext.js';
import { useOptionalPersonalization } from '@/components/PersonalizationContext.js';
import { useOptionalRunCodeStatus } from '@/components/RunCodeStatusContext.js';
import { Icon } from '@/icons/Icon.js';
import { useOptionalSentinelApiState } from '@/sentinel/SentinelApiContext.js';
import { useOptionalCatalogServer, useOptionalRefreshServerCapabilities } from '@/server/ServerContext.js';
import { useShellMode, type SettingsSection } from '@/server/ShellModeContext.js';

// Section modules (and their list/catalog APIs) load only when that tab mounts.
const ModelSettings = lazy(() => import('./ModelSettings.js'));
// Personas live under Roles and Personas (their model bindings sit alongside every other
// model role — see docs/model-roles.mdx), not as a section of their own here.
const ModelRoleSettings = lazy(() => import('./ModelRoleSettings.js'));
const ConnectorSettings = lazy(() => import('./ConnectorSettings.js'));
const MemorySection = lazy(() => import('./MemorySection.js'));
const SkillSettings = lazy(() => import('./SkillSettings.js'));
const SandboxSettings = lazy(() => import('./SandboxSettings.js'));
const ThemeSettings = lazy(() => import('./ThemeSettings.js'));
const PersonalizationSettings = lazy(() =>
  import('@/components/PersonalizationPanel.js').then(module => ({ default: module.PersonalizationPanel })),
);
const SentinelSettings = lazy(() =>
  import('@/sentinel/SentinelSettings.js').then(module => ({ default: module.SentinelSettings })),
);
const AuditLogSettings = lazy(() =>
  import('@/sentinel/AuditLogSettings.js').then(module => ({ default: module.AuditLogSettings })),
);

type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon:
    | 'cpu'
    | 'brain'
    | 'plug'
    | 'box-archive'
    | 'lightbulb'
    | 'cube'
    | 'robot'
    | 'palette'
    | 'lock'
    | 'clock-rotate-left';
};

const SETTINGS_PANEL_ID = 'settings-panel';

function settingsTabId(section: SettingsSection) {
  return `settings-tab-${section}`;
}

function SettingsSectionFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-8" role="status" aria-live="polite" aria-busy="true">
      <Spinner size={20} className="text-text-secondary" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

const TruefoundrySettingsBuilder = () => {
  const { settingsOpen, settingsSection: section, setSettingsOpen } = useShellMode();
  const catalog = useOptionalCatalogServer();
  const refreshServerCapabilities = useOptionalRefreshServerCapabilities();
  const { refresh: refreshDraftCatalog } = useDraftCatalog();
  // dock/widget panels are ~mobile width even on a wide viewport — keep Settings stacked.
  const compact = useCompactLayout();
  const navRef = useRef<HTMLElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ start: false, end: false });
  const hasSkills = catalog?.skillCatalog != null;
  const hasSandbox = useOptionalRunCodeStatus() != null;
  const hasPersonalization = useOptionalPersonalization() != null;
  const hasSentinel = useOptionalSentinelApiState() != null;

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  // Refresh catalogs whenever settings are closed or navigated away from.
  useEffect(() => {
    if (!settingsOpen) return;
    return () => {
      refreshDraftCatalog();
      refreshServerCapabilities?.();
    };
  }, [settingsOpen, refreshDraftCatalog, refreshServerCapabilities]);

  useEffect(() => {
    if (!hasSkills && section === 'skills') {
      setSettingsOpen(settingsOpen, 'models');
    }
    if (!hasSandbox && section === 'sandbox') {
      setSettingsOpen(settingsOpen, 'models');
    }
    if (!hasPersonalization && section === 'personalization') {
      setSettingsOpen(settingsOpen, 'models');
    }
    if (!hasSentinel && (section === 'permissions' || section === 'audit')) {
      setSettingsOpen(settingsOpen, 'models');
    }
  }, [hasSkills, hasSandbox, hasPersonalization, hasSentinel, section, settingsOpen, setSettingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      closeSettings();
    };
    // Capture so layout Escape handlers (sessions drawer / widget) do not also fire.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeSettings, settingsOpen]);

  const sections = useMemo<SettingsNavItem[]>(() => {
    const baseSections: SettingsNavItem[] = [
      { id: 'models', label: 'Models', icon: 'cpu' },
      { id: 'model-roles', label: 'Roles and Personas', icon: 'brain' },
      { id: 'connectors', label: 'Connectors', icon: 'plug' },
      // Not gated on a capability: memory is configured by pointing at a bank, so the section has
      // to be reachable while none is configured. It reads as off until one is.
      { id: 'memory', label: 'Memory', icon: 'box-archive' },
      { id: 'themes', label: 'Themes', icon: 'palette' },
    ];
    if (hasSkills) {
      baseSections.push({ id: 'skills', label: 'Skills', icon: 'lightbulb' });
    }
    if (hasSandbox) {
      baseSections.push({ id: 'sandbox', label: 'Sandbox', icon: 'cube' });
    }
    if (hasPersonalization) {
      baseSections.push({ id: 'personalization', label: 'Personalization', icon: 'robot' });
    }
    if (hasSentinel) {
      baseSections.push({ id: 'permissions', label: 'Permissions', icon: 'lock' });
      baseSections.push({ id: 'audit', label: 'Audit', icon: 'clock-rotate-left' });
    }
    return baseSections;
  }, [hasSkills, hasSandbox, hasPersonalization, hasSentinel]);

  // The one section both the tab strip and the body show. A stored section the host no longer
  // offers falls back to Models here, so the highlighted tab and the content cannot disagree.
  const activeSection = sections.find(item => item.id === section)?.id ?? 'models';
  const showFirstRunGuide = useOptionalAmanSetup() !== null && activeSection === 'models';

  const panelVisible = settingsOpen && catalog != null;

  const updateScrollEdges = useCallback(() => {
    const nav = navRef.current;
    if (nav == null) return;
    const start = nav.scrollLeft > 1;
    const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
    setScrollEdges(current => (current.start === start && current.end === end ? current : { start, end }));
  }, []);

  // Bring the selected tab into view, centred where the strip has room. Only the strip scrolls,
  // never the page, so a tab that is already visible stays put.
  useEffect(() => {
    if (!panelVisible) return;
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (nav != null && tab != null) {
      const navRect = nav.getBoundingClientRect();
      const tabRect = tab.getBoundingClientRect();
      nav.scrollLeft += tabRect.left - navRect.left - (navRect.width - tabRect.width) / 2;
    }
    updateScrollEdges();
  }, [panelVisible, activeSection, sections, updateScrollEdges]);

  useEffect(() => {
    if (!panelVisible) return;
    window.addEventListener('resize', updateScrollEdges);
    return () => window.removeEventListener('resize', updateScrollEdges);
  }, [panelVisible, updateScrollEdges]);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const current = sections.findIndex(item => item.id === activeSection);
    const next = tablistTargetIndex({ key: event.key, current, count: sections.length });
    if (next === null) return;
    const item = sections[next];
    if (item === undefined) return;
    event.preventDefault();
    setSettingsOpen(true, item.id);
    navRef.current?.querySelectorAll<HTMLElement>('[role="tab"]').item(next)?.focus();
  };

  if (!settingsOpen || !catalog) return null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-primary-bg">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
          onClick={closeSettings}
        >
          <Icon name="arrow-left" />
        </button>
        <h1 className="text-lg font-semibold tracking-tight text-text-primary">Settings</h1>
      </header>

      <div className={cn('flex min-h-0 flex-1 flex-col', !compact && 'md:flex-row')}>
        <div className={cn('relative min-w-0 w-full', !compact && 'md:w-48 md:flex-none')}>
          <nav
            ref={navRef}
            role="tablist"
            aria-label="Settings sections"
            onKeyDown={onTabKeyDown}
            onScroll={updateScrollEdges}
            className={cn(
              'flex w-full justify-start gap-1 overflow-x-auto border-b border-border bg-secondary-bg/40 p-2',
              compact ? 'min-w-0' : 'md:h-full md:flex-col md:border-b-0 md:border-r',
            )}
          >
            {sections.map(item => {
              const selected = item.id === activeSection;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={settingsTabId(item.id)}
                  aria-selected={selected}
                  aria-controls={SETTINGS_PANEL_ID}
                  tabIndex={selected ? 0 : -1}
                  {...(compact ? { title: item.label } : {})}
                  className={cn(
                    'flex min-h-9 items-center gap-2 rounded-md border border-transparent bg-transparent px-3 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
                    // Narrow panels scroll horizontally rather than crushing five labels together.
                    compact ? 'min-w-fit flex-none justify-center gap-1.5 px-2.5' : 'shrink-0',
                    selected
                      ? 'bg-primary-button-bg text-primary-button-text'
                      : 'text-text-secondary hover:bg-ghost-button-hover/60 hover:text-text-primary',
                  )}
                  onClick={() => {
                    setSettingsOpen(true, item.id);
                  }}
                >
                  <Icon name={item.icon} className="h-4 w-4 shrink-0" />
                  {compact ? <span className="truncate">{item.label}</span> : item.label}
                </button>
              );
            })}
          </nav>
          {scrollEdges.start ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-primary-bg to-transparent"
            />
          ) : null}
          {scrollEdges.end ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-primary-bg to-transparent"
            />
          ) : null}
        </div>

        <section
          id={SETTINGS_PANEL_ID}
          role="tabpanel"
          aria-labelledby={settingsTabId(activeSection)}
          className="flex flex-col h-full flex-1 overflow-y-auto scroll-pb-6 px-6 py-4"
        >
          <div className="w-full max-w-210 h-full min-h-0 flex flex-col mx-auto pb-6">
            {showFirstRunGuide ? <AmanFirstRunGuide placement="settings" className="mb-4 max-w-none shrink-0" /> : null}
            <Suspense fallback={<SettingsSectionFallback />}>
              {activeSection === 'models' ? <ModelSettings /> : null}
              {activeSection === 'model-roles' ? <ModelRoleSettings /> : null}
              {activeSection === 'connectors' ? <ConnectorSettings /> : null}
              {activeSection === 'memory' ? <MemorySection /> : null}
              {activeSection === 'themes' ? <ThemeSettings /> : null}
              {activeSection === 'skills' ? <SkillSettings /> : null}
              {activeSection === 'sandbox' ? <SandboxSettings /> : null}
              {activeSection === 'personalization' ? <PersonalizationSettings /> : null}
              {activeSection === 'permissions' ? <SentinelSettings /> : null}
              {activeSection === 'audit' ? <AuditLogSettings /> : null}
            </Suspense>
          </div>
        </section>
      </div>
    </div>
  );
};

export default TruefoundrySettingsBuilder;
