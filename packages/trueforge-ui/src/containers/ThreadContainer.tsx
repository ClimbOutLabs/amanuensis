'use client';

import { ThreadPrimitive, useAuiState } from '@assistant-ui/react';
import { useEffect, useRef, type ReactNode } from 'react';
import { preloadMarkdownOpenUI } from '../atoms/Markdown.js';
import { HelpChatPanel, HelpChoices } from '../help/HelpChatPanel.js';
import { useOptionalHelp } from '../help/HelpProvider.js';
import { AvatarActivityBridge } from '../hooks/useAvatarActivity.js';
import { ComposerBusyProvider } from '../hooks/useComposerBusyState.js';
import { useSyncSessionTitle } from '../hooks/useSyncSessionTitle.js';
import { SentinelStateProvider } from '../sentinel/SentinelStateProvider.js';
import { useOptionalShellMode } from '../server/ShellModeContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { isNewChatView } from '../utils/isNewChatView.js';
import { ApprovalFocusProvider } from './approvalFocus.js';
import { AssistantMessageContainer } from './AssistantMessageContainer.js';
import { ChatNoticeContainer } from './ChatNoticeContainer.js';
import { ConnectionStatusContainer } from './ConnectionStatusContainer.js';
import { DocumentIngestionStatusProvider } from './DocumentIngestionStatusProvider.js';
import { HistoryLoaderContainer } from './HistoryLoaderContainer.js';
import { ThreadImplementationPlanGrantControls } from './ImplementationPlanGrantControls.js';
import { MemoryTurnContextProvider } from './MemoryTurnContextProvider.js';
import { ModelUsageTurnProvider } from './ModelUsageTurnProvider.js';
import { PendingApprovalsBanner } from './PendingApprovalsBanner.js';
import { ResumeUnavailableContainer } from './ResumeUnavailableContainer.js';
import { TerminalErrorContainer } from './TerminalErrorContainer.js';
import { UserEditComposerContainer } from './UserEditComposerContainer.js';
import { UserMessageContainer } from './UserMessageContainer.js';
import { ThreadWorkOnRepoControls } from './WorkOnRepoControls.js';
import { WorkOnRepoPanelProvider } from './workOnRepoPanel.js';

export { isNewChatView } from '../utils/isNewChatView.js';

/** Mount-only lift, keyed by message.id via ThreadPrimitive.Messages. Only messages
 * that arrive after the thread's first paint animate; the initial history mounts
 * silently so opening a thread does not shimmer. Honors reduced-motion. */
function AnimatedMessageShell({ children, animate }: { children: ReactNode; animate: boolean }) {
  return (
    <div
      className={
        animate
          ? 'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:fill-mode-both motion-safe:duration-200'
          : undefined
      }
    >
      {children}
    </div>
  );
}

function ThreadMessage({ isEditing }: { isEditing: boolean }) {
  const role = useAuiState(s => s.message.role);
  if (role === 'user') {
    if (isEditing) {
      return <UserEditComposerContainer />;
    }
    return <UserMessageContainer />;
  }
  return <AssistantMessageContainer />;
}

export type ThreadContainerProps = {
  /** Composer for the empty-welcome and docked bottom areas. `<Thread />` passes `<ComposerContainer />`. */
  composer?: ReactNode;
};

export function ThreadContainer({ composer }: ThreadContainerProps) {
  useEffect(() => {
    void preloadMarkdownOpenUI();
  }, []);
  useSyncSessionTitle();

  const shell = useOptionalShellMode();
  const WelcomeScreen = useSlot('WelcomeScreen');
  const MessageListSkeleton = useSlot('MessageListSkeleton');
  const ScrollToBottomButton = useSlot('ScrollToBottomButton');
  const MessageGroup = useSlot('MessageGroup');
  const ThreadComposerAreaShell = useSlot('ThreadComposerAreaShell');
  const ThreadRootShell = useSlot('ThreadRootShell');
  const ThreadViewportShell = useSlot('ThreadViewportShell');

  const isEmpty = useAuiState(isNewChatView);
  const isLoading = useAuiState(s => s.thread.isLoading);
  const help = useOptionalHelp();
  const localThreadId = useAuiState(s => s.threadListItem.id);
  // The help chat takes the place of the welcome tour in the chat it was started in.
  const helpHere = help !== null && help.isSessionFor(localThreadId);
  // Entrance animation gate: shells mounted during the thread's first paint stay
  // static; only messages arriving afterwards animate. Resets on thread switch
  // since the container does not remount between threads.
  const threadKey = useAuiState(s => s.threadListItem.remoteId ?? 'new');
  const initialPaintDone = useRef(false);
  const paintedThreadKey = useRef(threadKey);
  if (paintedThreadKey.current !== threadKey) {
    paintedThreadKey.current = threadKey;
    initialPaintDone.current = false;
  }
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      initialPaintDone.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [threadKey]);
  const welcomeHeading =
    shell?.mode.status === 'active'
      ? shell.mode.agentName != null && shell.mode.agentName.length > 0
        ? shell.mode.agentName
        : shell.mode.isMutable && shell.mode.isCreateAgent
          ? 'Start building a new Agent'
          : undefined
      : undefined;

  return (
    <MemoryTurnContextProvider>
      <ModelUsageTurnProvider>
        <DocumentIngestionStatusProvider>
          <SentinelStateProvider>
            <ComposerBusyProvider>
              <AvatarActivityBridge />
              <ApprovalFocusProvider>
                <WorkOnRepoPanelProvider>
                  <ThreadPrimitive.Root asChild>
                    <ThreadRootShell>
                      {/* The empty chat opens at its top: the first frame is taller than the screen on purpose. */}
                      <ThreadPrimitive.Viewport asChild autoScroll={!isEmpty}>
                        <ThreadViewportShell isEmpty={isEmpty}>
                          {helpHere ? <HelpChatPanel /> : null}
                          {isEmpty && !helpHere && <WelcomeScreen heading={welcomeHeading} />}
                          {isEmpty && !isLoading && (
                            <>
                              {helpHere ? null : <ThreadWorkOnRepoControls />}
                              {composer}
                            </>
                          )}
                          {isLoading ? (
                            <MessageListSkeleton />
                          ) : (
                            !isEmpty && (
                              <>
                                <HistoryLoaderContainer />
                                <PendingApprovalsBanner />
                                <MessageGroup>
                                  <ThreadPrimitive.Messages>
                                    {({ message }) => (
                                      <AnimatedMessageShell animate={initialPaintDone.current}>
                                        <ThreadMessage
                                          isEditing={message.role === 'user' && message.composer.isEditing}
                                        />
                                      </AnimatedMessageShell>
                                    )}
                                  </ThreadPrimitive.Messages>
                                  <TerminalErrorContainer />
                                  <ChatNoticeContainer />
                                  <ResumeUnavailableContainer />
                                  <ConnectionStatusContainer />
                                </MessageGroup>
                                {helpHere ? <HelpChoices /> : null}
                              </>
                            )
                          )}
                        </ThreadViewportShell>
                      </ThreadPrimitive.Viewport>

                      {!isLoading && !isEmpty && (
                        <ThreadComposerAreaShell isEmpty={isEmpty}>
                          <ThreadPrimitive.ScrollToBottom asChild>
                            <ScrollToBottomButton />
                          </ThreadPrimitive.ScrollToBottom>
                          <ThreadImplementationPlanGrantControls />
                          <ThreadWorkOnRepoControls />
                          {composer}
                        </ThreadComposerAreaShell>
                      )}
                    </ThreadRootShell>
                  </ThreadPrimitive.Root>
                </WorkOnRepoPanelProvider>
              </ApprovalFocusProvider>
            </ComposerBusyProvider>
          </SentinelStateProvider>
        </DocumentIngestionStatusProvider>
      </ModelUsageTurnProvider>
    </MemoryTurnContextProvider>
  );
}
