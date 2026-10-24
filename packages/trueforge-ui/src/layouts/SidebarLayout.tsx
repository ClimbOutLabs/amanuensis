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

import { AgentDetailsToggleButton } from '../atoms/AgentDetailsToggleButton.js';
import { ChatHeaderMenu } from '../atoms/ChatHeaderMenu.js';
import {
  auiButtonClass,
  railMenuRowClassName,
  railSelectedClassName,
  sidebarRailButtonClassName,
} from '../atoms/lib/buttonClasses.js';
import { cn } from '../atoms/lib/cn.js';
import { useIsMobile } from '../atoms/lib/useIsMobile.js';
import { useLightDismiss } from '../atoms/lib/useLightDismiss.js';
import { NamedAgentHeaderLabel } from '../atoms/NamedAgentHeaderLabel.js';
import { PageHeader } from '../atoms/PageHeader.js';
import { DropdownMenu } from '../atoms/primitives/DropdownMenu.js';
import { Spinner } from '../atoms/primitives/Spinner.js';
import { ShellActions } from '../atoms/ShellActions.js';
import { AgentConfigDrawerContainer } from '../containers/AgentConfigDrawerContainer.js';
import { Thread } from '../containers/Thread.js';
import { ThreadListContainer } from '../containers/ThreadListContainer.js';
import { useOpenMostRecentChat } from '../containers/useOpenMostRecentChat.js';
import { HelpNewChatBridge } from '../help/HelpStuckButton.js';
import { Icon } from '../icons/Icon.js';
import { shellIsCreateAgent, useOptionalShellMode, type ShellMode } from '../server/ShellModeContext.js';
import { resolveBrandChrome } from '../theme/brand.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { useBrand } from '../theme/ThemeProvider.js';
import { railEntryFor, type RailEntry } from './railEntry.js';

const TruefoundrySettingsBuilder = lazy(() => import('../containers/SettingsBuilder/index.js'));
const SchedulesPage = lazy(() =>
  import('../atoms/schedules/SchedulesPage.js').then(m => ({ default: m.SchedulesPage })),
);
const SpacesView = lazy(() => import('../containers/SpacesView.js'));

const brandLogoClassName = 'h-5 w-5 max-w-40 shrink-0 object-contain';
const railWidthClassName = 'w-20';

function isRecentHistoryVisible({ overlayOpen, mode }: { overlayOpen: boolean; mode?: ShellMode }): boolean {
  return !overlayOpen && mode?.status === 'active' && !mode.isCreateAgent;
}

/**
 * Presses on these never count as outside the chat list: the rail's Chats entry toggles it, and the
 * list's own menus and dialogs open in a layer outside it.
 */
const CHAT_LIST_INSIDE_SELECTOR = '[data-chat-list-trigger], [role="menu"], [role="dialog"], [role="alertdialog"]';

/**
 * Nav buttons only (Chats through Agents). Returned as plain siblings, not wrapped in their own
 * `<nav>`, so the caller lays them out in one scrolling flex column with the footer actions.
 * New chat lives at the top of the chat list; Build agent, Sessions and Settings live under More.
 */
function SidebarNavItems({
  selected,
  chatListOpen,
  onChats,
}: {
  selected: RailEntry;
  chatListOpen: boolean;
  onChats: () => void;
}): ReactNode {
  const AgentsLibraryButton = useSlot('AgentsLibraryButton');
  const SchedulesButton = useSlot('SchedulesButton');
  const SpacesButton = useSlot('SpacesButton');
  const chatsSelected = selected === 'chats';

  return (
    <>
      <button
        type="button"
        title="Chats"
        aria-expanded={chatListOpen}
        aria-current={chatsSelected ? 'page' : undefined}
        data-chat-list-trigger=""
        className={auiButtonClass({
          variant: 'ghost',
          className: cn(sidebarRailButtonClassName, chatsSelected && railSelectedClassName),
        })}
        onClick={event => {
          // The mobile nav drawer closes on any rail button click via the aside's onNavigate
          // bubble handler; Chats must not dismiss the drawer, since it reveals the list inside it.
          event.stopPropagation();
          onChats();
        }}
      >
        <Icon name="message-square-text" size={14} />
        <span className="text-center">Chats</span>
      </button>
      <SpacesButton compact selected={selected === 'spaces'} />
      <SchedulesButton compact selected={selected === 'schedules'} />
      <AgentsLibraryButton compact selected={selected === 'agents'} />
    </>
  );
}

/** Shared desktop + mobile icon+label rail (brand, nav, footer actions). */
function SidebarRail({
  onNavigate,
  className,
  railRef,
  selected,
  chatListOpen,
  onChats,
  ...dialogProps
}: {
  onNavigate?: () => void;
  className?: string;
  railRef?: Ref<HTMLElement>;
  selected: RailEntry;
  chatListOpen: boolean;
  onChats: () => void;
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
        const button = target.closest('button');
        // Opening the More menu is not a navigation: the drawer stays open while its menu is shown.
        if (button == null || button.getAttribute('aria-haspopup') === 'menu') return;
        onNavigate();
      }}
      {...dialogProps}
    >
      <div className="flex h-14 w-full shrink-0 items-center justify-center text-text-primary">
        <BrandLogo variant={chrome.collapsedVariant} className={brandLogoClassName} />
      </div>
      {/* One scrolling flex column: on a short viewport it scrolls (min-h-0 + overflow-y-auto) instead
          of the footer painting over the nav. The footer sits at the bottom when there is room. */}
      <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto p-1" aria-label="Sidebar">
        <SidebarNavItems selected={selected} chatListOpen={chatListOpen} onChats={onChats} />
        <div className="mt-auto flex flex-col items-center gap-1 pt-1">
          <UserAvatar labeled />
          <RailMoreMenu selected={selected === 'more'} />
        </div>
      </nav>
    </aside>
  );
}

/**
 * The kebab at the bottom of the rail. Everything that is not a rail destination lives here: Build agent,
 * Sessions, Settings, the theme, Bug report and the host's log-out. It closes on an outside click or Escape.
 */
function RailMoreMenu({ selected }: { selected: boolean }) {
  const shell = useOptionalShellMode();
  const showNewActions = shell?.isNewChatEnabled !== false;
  const handleNewAgent = () => {
    shell?.setLibraryOpen(false);
    shell?.setSessionsOpen(false);
    if (shell?.isComposerEnabled) {
      shell.openAgentBuilder();
    }
  };
  return (
    <DropdownMenu
      align="start"
      side="top"
      className="min-w-44 rounded-[1.25rem] border border-border bg-card-bg p-1"
      trigger={
        <button
          type="button"
          aria-label="More"
          title="More"
          aria-current={selected ? 'page' : undefined}
          className={auiButtonClass({
            variant: 'ghost',
            className: cn(sidebarRailButtonClassName, selected && railSelectedClassName),
          })}
        >
          <Icon name="ellipsis-vertical" size={14} />
          <span className="text-center">More</span>
        </button>
      }
    >
      <div className="flex flex-col">
        {showNewActions && shell?.isComposerEnabled ? (
          <button type="button" aria-label="Start new agent" className={railMenuRowClassName} onClick={handleNewAgent}>
            <Icon name="agent-2" size={14} />
            Build agent
          </button>
        ) : null}
        <ShellActions labeled rows className="flex-col items-stretch gap-0.5" />
      </div>
    </DropdownMenu>
  );
}

export function SidebarLayout({ className }: { className?: string }) {
  const shell = useOptionalShellMode();
  const isMobile = useIsMobile();
  const AgentDetailsPage = useSlot('AgentDetailsPage');
  const AgentsLibrary = useSlot('AgentsLibrary');
  const SessionsPage = useSlot('SessionsPage');
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
  const railEntry = railEntryFor(shell);
  const openMostRecentChat = useOpenMostRecentChat();
  const chatListRef = useRef<HTMLElement>(null);
  // Opened from the rail, the docked chat list behaves like a menu: it closes on a press outside,
  // Escape, or picking a chat. Left open from an earlier visit, it stays put.
  const [chatListFromRail, setChatListFromRail] = useState(false);
  const chatListDismissible = chatListFromRail && showRecentHistory && !isMobile;

  const closeChatList = useCallback(() => {
    setChatListFromRail(false);
    shell?.setHistoryCollapsed(true);
  }, [shell]);

  const handleChats = () => {
    if (shell === null) return;
    if (showRecentHistory) {
      closeChatList();
      return;
    }
    const alreadyOnChats = railEntry === 'chats';
    shell.setSettingsOpen(false);
    shell.setLibraryOpen(false);
    shell.setSessionsOpen(false);
    shell.setSchedulesOpen(false);
    shell.closeSpaces();
    shell.setHistoryCollapsed(false);
    setChatListFromRail(true);
    if (!alreadyOnChats) openMostRecentChat();
  };

  useLightDismiss({
    open: chatListDismissible,
    isInside: target =>
      chatListRef.current?.contains(target) === true || target.closest(CHAT_LIST_INSIDE_SELECTOR) !== null,
    onDismiss: closeChatList,
  });

  useEffect(() => {
    if (!showRecentHistory) setChatListFromRail(false);
  }, [showRecentHistory]);

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
        selected={railEntry}
        chatListOpen={showRecentHistory}
        onChats={handleChats}
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
          singleLine
          menu={!overlayOpen ? <ChatHeaderMenu /> : null}
          className={cn(
            'bg-topbar-bg',
            // An open overlay (Settings, Library, Sessions, ...) brings its own header and this bar
            // has no menu button or title there, so hide it at every width rather than leave a blank band.
            overlayOpen && 'hidden',
          )}
          start={
            !overlayOpen ? (
              // Sits in a rail-wide strip on the rail's background, so it lines up with the rail it opens.
              <div
                className={cn(
                  railWidthClassName,
                  '-ml-4 flex shrink-0 items-center justify-center self-stretch border-r border-border bg-sidebar-bg md:hidden',
                )}
              >
                <button
                  ref={menuBtnRef}
                  type="button"
                  aria-label="Navigation"
                  aria-expanded={mobileNavOpen}
                  className={auiButtonClass({ variant: 'ghost', size: 'icon' })}
                  onClick={() => setMobileNavOpen(true)}
                >
                  <Icon name="bars" />
                </button>
              </div>
            ) : null
          }
          title={!overlayOpen ? <NamedAgentHeaderLabel /> : null}
          end={
            !overlayOpen ? (
              <>
                <AgentDetailsToggleButton />
                <SaveAgentButton />
              </>
            ) : null
          }
        />

        {/* A folded chat list lends the chat column part of its width. */}
        <div className={cn('flex min-h-0 min-w-0 flex-1', !showRecentHistory && '[--thread-extra-left:8rem]')}>
          {showRecentHistory ? (
            <aside
              ref={chatListRef}
              aria-label="Recent chats"
              className="hidden min-h-0 w-64 shrink-0 border-r border-border bg-sidebar-bg md:flex"
            >
              <ThreadListContainer
                variant="recent-history"
                {...(chatListDismissible ? { onThreadOpen: closeChatList } : {})}
              />
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
              selected={railEntry}
              chatListOpen={showRecentHistory}
              onChats={handleChats}
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
