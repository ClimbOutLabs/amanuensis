'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useEffect } from 'react';

import { headerActionClassName } from '../atoms/lib/buttonClasses.js';
import { useOptionalShellMode, type ShellModeContextValue } from '../server/ShellModeContext.js';
import { HELP_BUTTON_LABEL } from './helpModel.js';
import { useOptionalHelp } from './HelpProvider.js';
import { describeHelpScreen } from './helpScreen.js';
import { readLastErrorText } from './lastError.js';

/** The top-bar button. It only starts the help chat; the new-chat bridge opens the chat inside the runtime. */
export function HelpStuckButton() {
  const help = useOptionalHelp();
  const shell = useOptionalShellMode();
  if (help === null) {
    return null;
  }
  const onClick = () => {
    help.start({
      screen: describeHelpScreen(
        shell === null
          ? null
          : {
              settingsOpen: shell.settingsOpen,
              settingsSection: shell.settingsSection,
              libraryOpen: shell.libraryOpen,
              sessionsOpen: shell.sessionsOpen,
              schedulesOpen: shell.schedulesOpen,
              spacesOpen: shell.spacesOpen,
            },
      ),
      lastError: readLastErrorText(),
    });
  };
  return (
    <button
      type="button"
      aria-label={HELP_BUTTON_LABEL}
      className={headerActionClassName}
      onClick={onClick}
      data-testid="help-stuck-button"
    >
      {/* A phone header has room for one line, so the label shortens there. */}
      <span className="sm:hidden">Help</span>
      <span className="hidden sm:inline">{HELP_BUTTON_LABEL}</span>
    </button>
  );
}

/** Closes the overlays and opens a fresh chat, the same way the New Chat buttons do. */
function openFreshChat({
  shell,
  switchToNewThread,
}: {
  shell: ShellModeContextValue | null;
  switchToNewThread: () => Promise<unknown> | unknown;
}) {
  if (shell === null) {
    void Promise.resolve(switchToNewThread()).catch(() => undefined);
    return;
  }
  shell.setLibraryOpen(false);
  shell.setSessionsOpen(false);
  shell.setSettingsOpen(false);
  shell.setSchedulesOpen(false);
  shell.closeSpaces();
  if (shell.isComposerEnabled) {
    shell.openDraft();
    return;
  }
  void Promise.resolve(switchToNewThread()).catch(() => undefined);
}

/**
 * Mounted inside the chat's runtime. When a help chat starts it opens a fresh chat, then binds the
 * help chat to that chat's thread. Toasts can start help without the runtime, so this does the work.
 */
export function HelpNewChatBridge() {
  const help = useOptionalHelp();
  const shell = useOptionalShellMode();
  const aui = useAui();
  const localId = useAuiState(s => s.threadListItem.id);
  const session = help?.session ?? null;
  const openNonce = session?.openNonce;
  const idBeforeOpen = session?.idBeforeOpen ?? null;
  const boundThreadId = session?.boundThreadId;

  useEffect(() => {
    // Opening a draft remounts this bridge with the runtime, so "already opened" must live in the
    // provider's session. A ref here resets on remount and reopens the draft in a loop.
    if (help === null || openNonce === undefined || idBeforeOpen !== null) {
      return;
    }
    help.update({ idBeforeOpen: localId });
    openFreshChat({ shell, switchToNewThread: () => aui.threads().switchToNewThread() });
  }, [help, openNonce, idBeforeOpen, localId, shell, aui]);

  useEffect(() => {
    if (help === null || session === null || boundThreadId !== undefined) {
      return;
    }
    if (idBeforeOpen !== null && localId !== idBeforeOpen) {
      help.bindThread(localId);
    }
  }, [help, session, boundThreadId, idBeforeOpen, localId]);

  return null;
}
