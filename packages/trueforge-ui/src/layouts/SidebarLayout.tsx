'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
} from 'react';

import { useAui } from '../assistant-ui.js';
import { AgentDetailsToggleButton } from '../atoms/AgentDetailsToggleButton.js';
import { auiButtonClass, sidebarRailButtonClassName } from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { NamedAgentHeaderLabel } from '../atoms/NamedAgentHeaderLabel.js';
import { PageHeader } from '../atoms/PageHeader.js';
import { Spinner } from '../atoms/primitives/Spinner.js';
import { ShellActions } from '../atoms/ShellActions.js';
import { AgentConfigDrawerContainer } from '../containers/AgentConfigDrawerContainer.js';
import { Thread } from '../containers/Thread.js';
import { ThreadListContainer } from '../containers/ThreadListContainer.js';
import { HelpNewChatBridge } from '../help/HelpStuckButton.js';
import { Icon } from '../icons/Icon.js';
import { shellIsCreateAgent, useOptionalShellMode, type ShellMode } from '../server/ShellModeContext.js';
import { resolveBrandChrome } from '../theme/brand.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { useBrand } from '../theme/ThemeProvider.js';

const TruefoundrySettingsBuilder = lazy(() => import('../containers/SettingsBuilder/index.js'));
const SchedulesPage = lazy(() =>
  import('../atoms/schedules/SchedulesPage.js').then(m => ({ default: m.SchedulesPage })),
);
const SpacesView = lazy(() => import('../containers/SpacesView.js'));

const brandLogoClassName = 'h-5 w-5 max-w-40 shrink-0 object-contain';
const railWidthClassName = 'w-20';

const railActionButtonClassName = cn(sidebarRailButtonClassName, 'text-sidebar-text');

/** The selected rail item: the soft fill the composer's open menu uses, not a solid block. */
const railSelectedClassName =
  'bg-dropdown-selected-item-bg text-dropdown-selected-item-text hover:text-dropdown-selected-item-text';

function isRecentHistoryVisible({ overlayOpen, mode }: { overlayOpen: boolean; mode?: ShellMode }): boolean {
  return !overlayOpen && mode?.status === 'active' && !mode.isCreateAgent;
}

/**
 * Nav buttons only (New Chat through Build Agent). Returned as plain siblings — not wrapped
 * in their own `<nav>` — so the caller can lay them out as siblings of the footer actions
 * in one scrolling flex column instead of two separately-boxed groups that can paint over
 * each other on a short viewport.
 *
 * Order is the everyday-user order: New chat, Chats, Spaces, Schedules, Agents, Build agent.
 * Sessions, Settings and the other footer actions live in `ShellActions`, below these.
 */
function SidebarNavItems({
  showHistoryToggle = false,
  historyCollapsed = false,
  onToggleHistoryCollapsed,
}: {
  showHistoryToggle?: boolean;
  historyCollapsed?: boolean;
  onToggleHistoryCollapsed?: () => void;
}): ReactNode {
  const aui = useAui();
  const shell = useOptionalShellMode();
  const AgentsLibraryButton = useSlot('AgentsLibraryButton');
  const SchedulesButton = useSlot('SchedulesButton');
  const SpacesButton = useSlot('SpacesButton');
  const showNewActions = shell?.isNewChatEnabled !== false;
  const overlayOpen =
    shell?.settingsOpen === true ||
    shell?.libraryOpen === true ||
    shell?.sessionsOpen === true ||
    shell?.schedulesOpen === true ||
    shell?.spacesOpen === true;
  const mode = shell?.mode;
  const newChatSelected =
    !overlayOpen &&
    mode?.status === 'active' &&
    !mode.isCreateAgent &&
    shell?.historyAgentFilter?.intent !== 'try-agent';
  const newAgentSelected = !overlayOpen && mode != null && shellIsCreateAgent(mode);
  const historyToggleLabel = historyCollapsed ? 'Show recent chats' : 'Hide recent chats';

  const handleNewChat = () => {
    shell?.setLibraryOpen(false);
    shell?.setSessionsOpen(false);
    if (shell?.isComposerEnabled) {
      shell.openDraft();
      return;
    }
    shell?.setSettingsOpen(false);
    shell?.setSchedulesOpen(false);
    shell?.closeSpaces();
    void Promise.resolve(aui.threads().switchToNewThread()).catch(() => undefined);
  };

  const handleNewAgent = () => {
    shell?.setLibraryOpen(false);
    shell?.setSessionsOpen(false);
    if (shell?.isComposerEnabled) {
      shell.openAgentBuilder();
    }
  };

  return (
    <>
      {showNewActions ? (
        <button
          type="button"
          aria-label="Start new chat"
          title="New chat"
          aria-current={newChatSelected ? 'page' : undefined}
          className={auiButtonClass({
            variant: 'ghost',
            className: cn(railActionButtonClassName, newChatSelected && railSelectedClassName),
          })}
          onClick={handleNewChat}
        >
          <Icon name="square-pen" size={14} />
          <span className="text-center">New chat</span>
        </button>
      ) : null}
      {showHistoryToggle ? (
        <button
          type="button"
          aria-label={historyToggleLabel}
          aria-pressed={historyCollapsed}
          title={historyToggleLabel}
          className={auiButtonClass({ variant: 'ghost', className: railActionButtonClassName })}
          onClick={event => {
            // The mobile nav drawer closes on any rail button click via the aside's
            // onNavigate bubble handler; the history toggle must not dismiss the
            // drawer — its whole point is to reveal the chats panel inside it.
            event.stopPropagation();
            onToggleHistoryCollapsed?.();
          }}
        >
          <Icon name="message-square-text" size={14} />
          <span className="text-center">Chats</span>
        </button>
      ) : null}
      <SpacesButton compact />
      <SchedulesButton compact />
      <AgentsLibraryButton compact />
      {showNewActions && shell?.isComposerEnabled ? (
        <button
          type="button"
          aria-label="Start new agent"
          title="New Agent"
          aria-current={newAgentSelected ? 'page' : undefined}
          className={auiButtonClass({
            variant: 'ghost',
            className: cn(railActionButtonClassName, newAgentSelected && railSelectedClassName),
          })}
          onClick={handleNewAgent}
        >
          <Icon name="agent-2" size={14} />
          <span className="text-center whitespace-nowrap">Build agent</span>
        </button>
      ) : null}
    </>
  );
}

/** Shared desktop + mobile icon+label rail (brand, nav, footer actions). */
function SidebarRail({
  onNavigate,
  className,
  railRef,
  showHistoryToggle = false,
  historyCollapsed = false,
  onToggleHistoryCollapsed,
  ...dialogProps
}: {
  onNavigate?: () => void;
  className?: string;
  railRef?: Ref<HTMLElement>;
  /** Whether the recent-chats history panel could be showing right now (controls toggle visibility). */
  showHistoryToggle?: boolean;
  /** Whether the user has hidden the recent-chats history panel. */
  historyCollapsed?: boolean;
  onToggleHistoryCollapsed?: () => void;
} & Omit<ComponentPropsWithoutRef<'aside'>, 'children' | 'className'>): ReactNode {
  const brand = useBrand();
  const chrome = resolveBrandChrome(brand);
  const BrandLogo = useSlot('BrandLogo');
  const UserAvatar = useSlot('UserAvatar');

  return (
    <aside
      ref={railRef}
      className={cn(
        railWidthClassName,
        'flex min-h-0 shrink-0 flex-col border-r border-border bg-sidebar-bg',
        className,
      )}
      onClick={event => {
        if (onNavigate == null) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('button') != null) onNavigate();
      }}
      {...dialogProps}
    >
      <div className="flex h-14 w-full shrink-0 items-center justify-center text-text-primary">
        <BrandLogo variant={chrome.collapsedVariant} className={brandLogoClassName} />
      </div>
      {/* One scrolling flex column: nav buttons and footer actions are plain siblings with
          a consistent gap, so on a short viewport the column scrolls (min-h-0 + overflow-y-auto)
          instead of the footer actions painting over the nav buttons or vice versa. */}
      <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto p-1" aria-label="Sidebar">
        <SidebarNavItems
          showHistoryToggle={showHistoryToggle}
          historyCollapsed={historyCollapsed}
          onToggleHistoryCollapsed={onToggleHistoryCollapsed}
        />
        <ShellActions labeled className="flex-col" />
        <UserAvatar labeled className="mt-1" />
      </nav>
    </aside>
  );
}

export function SidebarLayout({ className }: { className?: string }) {
  const shell = useOptionalShellMode();
  const isMobile = useIsMobile();
  const AgentDetailsPage = useSlot('AgentDetailsPage');
  const AgentsLibrary = useSlot('AgentsLibrary');
  const SessionsPage = useSlot('SessionsPage');
  const ClearChatButton = useSlot('ClearChatButton');
  const SaveAgentButton = useSlot('SaveAgentButton');
  const SelectAgentEmptyState = useSlot('SelectAgentEmptyState');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const isIdle = shell?.mode.status === 'idle';
  const settingsOpen = shell?.settingsOpen === true;
  const libraryOpen = shell?.libraryOpen === true;
  const sessionsOpen = shell?.sessionsOpen === true;
  const schedulesOpen = shell?.schedulesOpen === true;
  const spacesOpen = shell?.spacesOpen === true;
  const overlayOpen = settingsOpen || libraryOpen || sessionsOpen || schedulesOpen || spacesOpen;
  const showAgentConfig =
    shell != null && shellIsCreateAgent(shell.mode) && !overlayOpen && (!isMobile || shell.agentConfigOpen);
  const recentHistoryAvailable = isRecentHistoryVisible({ overlayOpen, mode: shell?.mode });
  const historyCollapsed = shell?.historyCollapsed === true;
  const showRecentHistory = recentHistoryAvailable && !historyCollapsed;
  const toggleHistoryCollapsed = useCallback(
    () => shell?.setHistoryCollapsed(!historyCollapsed),
    [shell, historyCollapsed],
  );

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    const main = mainRef.current;
    if (mobileNavOpen) {
      wasOpen.current = true;
      if (main) main.inert = true;
      dialogRef.current?.focus();
      return;
    }
    if (wasOpen.current) {
      if (main) main.inert = false;
      menuBtnRef.current?.focus();
      wasOpen.current = false;
    }
  }, [mobileNavOpen]);

  return (
    <div className={cn('relative flex h-full min-h-0 w-full min-w-0', className)}>
      <HelpNewChatBridge />
      <SidebarRail
        className="hidden md:flex"
        showHistoryToggle={recentHistoryAvailable}
        historyCollapsed={historyCollapsed}
        onToggleHistoryCollapsed={toggleHistoryCollapsed}
      />

      {showAgentConfig ? (
        <aside
          role="dialog"
          aria-label="Agent Config"
          className="absolute inset-y-0 left-0 z-20 w-full max-w-sm border-r border-border shadow-xl md:static md:z-auto md:max-w-140 md:flex-1 md:shadow-none 2xl:max-w-150"
        >
          <AgentConfigDrawerContainer showClose={isMobile} />
        </aside>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary-bg">
        {/* Desktop keeps shell chrome in the rail footer (always mounted, including
            when visually hidden on small screens so host action-slot state persists).
            Mobile reaches theme/settings via the nav drawer rail. */}
        <PageHeader
          helpAction={!overlayOpen}
          className={cn(
            'bg-topbar-bg',
            // An open overlay (Settings, Library, Sessions, ...) brings its own header and this bar
            // has no menu button or title there, so hide it at every width rather than leave a blank band.
            overlayOpen && 'hidden',
          )}
          start={
            !overlayOpen ? (
              <button
                ref={menuBtnRef}
                type="button"
                aria-label="Navigation"
                aria-expanded={mobileNavOpen}
                className={cn(auiButtonClass({ variant: 'ghost', size: 'icon' }), 'md:hidden')}
                onClick={() => setMobileNavOpen(true)}
              >
                <Icon name="bars" />
              </button>
            ) : null
          }
          title={!overlayOpen ? <NamedAgentHeaderLabel /> : null}
          end={
            !overlayOpen ? (
              <>
                <ClearChatButton />
                <AgentDetailsToggleButton />
                <SaveAgentButton />
              </>
            ) : null
          }
        />

        <div className="flex min-h-0 min-w-0 flex-1">
          {showRecentHistory ? (
            <aside
              aria-label="Recent chats"
              className="hidden min-h-0 w-64 shrink-0 border-r border-border bg-sidebar-bg md:flex"
            >
              <ThreadListContainer variant="recent-history" />
            </aside>
          ) : null}

          <div ref={mainRef} className="min-h-0 min-w-0 flex-1">
            {settingsOpen ? (
              <Suspense
                fallback={
                  <div
                    className="flex h-full items-center justify-center"
                    role="status"
                    aria-live="polite"
                    aria-busy="true"
                  >
                    <Spinner size={28} className="text-text-primary" />
                    <span className="sr-only">Loading</span>
                  </div>
                }
              >
                <TruefoundrySettingsBuilder />
              </Suspense>
            ) : sessionsOpen ? (
              <SessionsPage />
            ) : libraryOpen && shell?.libraryAgentId != null ? (
              <AgentDetailsPage key={shell.libraryAgentId} agentId={shell.libraryAgentId} />
            ) : libraryOpen ? (
              <AgentsLibrary onSelectAgent={() => setMobileNavOpen(false)} />
            ) : schedulesOpen ? (
              <Suspense
                fallback={
                  <div
                    className="flex h-full items-center justify-center"
                    role="status"
                    aria-live="polite"
                    aria-busy="true"
                  >
                    <Spinner size={28} className="text-text-primary" />
                    <span className="sr-only">Loading</span>
                  </div>
                }
              >
                <SchedulesPage />
              </Suspense>
            ) : spacesOpen ? (
              <Suspense
                fallback={
                  <div
                    className="flex h-full items-center justify-center"
                    role="status"
                    aria-live="polite"
                    aria-busy="true"
                  >
                    <Spinner size={28} className="text-text-primary" />
                    <span className="sr-only">Loading</span>
                  </div>
                }
              >
                <SpacesView />
              </Suspense>
            ) : isIdle ? (
              <SelectAgentEmptyState />
            ) : (
              <Thread />
            )}
          </div>
        </div>
      </div>

      {/* Mobile: same narrow rail as desktop, plus the recent-chats panel when expanded.
          The desktop recent-chats aside is `hidden` below the md breakpoint, so without
          this the Show/Hide recent chats toggle is a no-op in portrait. */}
      {mobileNavOpen ? (
        <>
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 z-[9] cursor-pointer bg-[var(--overlay)] md:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-label="Navigation"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 z-10 flex shadow-lg outline-none md:hidden"
          >
            <SidebarRail
              onNavigate={() => setMobileNavOpen(false)}
              showHistoryToggle={recentHistoryAvailable}
              historyCollapsed={historyCollapsed}
              onToggleHistoryCollapsed={toggleHistoryCollapsed}
            />
            {showRecentHistory ? (
              <div
                role="complementary"
                aria-label="Recent chats"
                className="h-full w-64 shrink-0 border-l border-border bg-sidebar-bg"
              >
                <ThreadListContainer variant="recent-history" onThreadOpen={() => setMobileNavOpen(false)} />
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
