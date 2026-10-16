'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';

import { useDraftCatalog } from '@/atoms/draft/DraftCatalogProvider.js';
import { auiButtonClass } from '@/atoms/lib/buttonClasses.js';
import { cn } from '@/atoms/lib/cn.js';
import { useCompactLayout } from '@/atoms/lib/CompactLayoutContext.js';
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
const MemorySettings = lazy(() => import('./MemorySettings.js'));
const MemoryVaultSettings = lazy(() =>
  import('@/atoms/memory/MemoryVaultPage.js').then(module => ({ default: module.MemoryVaultPage })),
);
const SkillSettings = lazy(() => import('./SkillSettings.js'));
const SandboxSettings = lazy(() => import('./SandboxSettings.js'));
const ThemeSettings = lazy(() => import('./ThemeSettings.js'));
const PersonalizationSettings = lazy(() =>
  import('@/components/PersonalizationPanel.js').then(module => ({ default: module.PersonalizationPanel })),
);
const SentinelSettings = lazy(() =>
  import('@/sentinel/SentinelSettings.js').then(module => ({ default: module.SentinelSettings })),
);

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
  const hasSkills = catalog?.skillCatalog != null;
  const hasSandbox = useOptionalRunCodeStatus() != null;
  const hasPersonalization = useOptionalPersonalization() != null;
  const hasSentinel = useOptionalSentinelApiState() != null;
  // A new owner lands on Models first, so the first-run checklist shows there until put away.
  const showFirstRunGuide = useOptionalAmanSetup() !== null && section === 'models';

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
    if (!hasSentinel && section === 'permissions') {
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

  const sections = useMemo<
    Array<{
      id: SettingsSection;
      label: string;
      icon: 'cpu' | 'brain' | 'plug' | 'box-archive' | 'lightbulb' | 'cube' | 'robot' | 'palette' | 'save' | 'lock';
    }>
  >(() => {
    const baseSections: Array<{
      id: SettingsSection;
      label: string;
      icon: 'cpu' | 'brain' | 'plug' | 'box-archive' | 'lightbulb' | 'cube' | 'robot' | 'palette' | 'save' | 'lock';
    }> = [
      { id: 'models', label: 'Models', icon: 'cpu' },
      { id: 'model-roles', label: 'Roles and Personas', icon: 'brain' },
      { id: 'connectors', label: 'Connectors', icon: 'plug' },
      // Not gated on a capability: memory is configured by pointing at a bank, so the section has
      // to be reachable while none is configured. It reads as off until one is.
      { id: 'memory', label: 'Memory', icon: 'box-archive' },
      { id: 'themes', label: 'Themes', icon: 'palette' },
      { id: 'memory-vault', label: 'Memory vault', icon: 'save' },
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
    }
    return baseSections;
  }, [hasSkills, hasSandbox, hasPersonalization, hasSentinel]);

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
        <nav
          aria-label="Settings sections"
          className={cn(
            'flex w-full gap-1 overflow-x-auto border-b border-border bg-secondary-bg/40 p-2',
            compact ? 'min-w-0' : 'justify-center md:w-48 md:flex-col md:justify-start md:border-b-0 md:border-r',
          )}
        >
          {sections.map(item => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              {...(compact ? { title: item.label } : {})}
              className={cn(
                'flex min-h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
                // Narrow panels scroll horizontally rather than crushing five labels together.
                compact ? 'min-w-fit flex-none justify-center gap-1.5 px-2.5' : 'shrink-0',
                section === item.id
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
          ))}
        </nav>

        <section className="flex flex-col h-full flex-1 overflow-y-hidden px-6 py-4">
          <div className="w-full max-w-210 h-full min-h-0 flex flex-col mx-auto">
            {showFirstRunGuide ? <AmanFirstRunGuide placement="settings" className="mb-4 max-w-none shrink-0" /> : null}
            <Suspense fallback={<SettingsSectionFallback />}>
              {section === 'models' ? <ModelSettings /> : null}
              {section === 'model-roles' ? <ModelRoleSettings /> : null}
              {section === 'connectors' ? <ConnectorSettings /> : null}
              {section === 'memory' ? <MemorySettings /> : null}
              {section === 'themes' ? <ThemeSettings /> : null}
              {section === 'memory-vault' ? <MemoryVaultSettings /> : null}
              {section === 'skills' && hasSkills ? <SkillSettings /> : null}
              {section === 'sandbox' && hasSandbox ? <SandboxSettings /> : null}
              {section === 'personalization' && hasPersonalization ? <PersonalizationSettings /> : null}
              {section === 'permissions' && hasSentinel ? <SentinelSettings /> : null}
            </Suspense>
          </div>
        </section>
      </div>
    </div>
  );
};

export default TruefoundrySettingsBuilder;
