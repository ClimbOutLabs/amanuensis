'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import { useEffect, useRef } from 'react';

import { Button } from '../atoms/primitives/Button.js';
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
    <Button type="button" variant="ghost" size="small" onClick={onClick} data-testid="help-stuck-button">
      {HELP_BUTTON_LABEL}
    </Button>
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
  const openedFor = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (help === null || openNonce === undefined || openedFor.current === openNonce) {
      return;
    }
    openedFor.current = openNonce;
    help.update({ idBeforeOpen: localId });
    openFreshChat({ shell, switchToNewThread: () => aui.threads().switchToNewThread() });
  }, [help, openNonce, localId, shell, aui]);

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
