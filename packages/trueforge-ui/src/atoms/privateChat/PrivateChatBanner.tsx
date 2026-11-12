'use client';

import { useAui, useAuiState } from '@assistant-ui/react';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { useEffect, useState } from 'react';

import { useToasterOptional } from '../../containers/ToasterContainer.js';
import { Icon } from '../../icons/Icon.js';
import { onPersonaMutationSettled } from '../../personaMutationGate.js';
import { hasChatPrivacy } from '../../plugins/trueforge-agent-server-adapter/privateChats.js';
import { forgetPrivateChat } from '../../server/privateChatStore.js';
import { useOptionalServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../primitives/Dialog.js';
import { PRIVATE_CHAT_CHOICE_LINE, PRIVATE_CHAT_DELETE_WARNING, privateChatBannerLine } from './privateChatCopy.js';
import { usePrivateChatFrame } from './usePrivateChatFrame.js';

const CLOSE_FAILED_MESSAGE = 'This chat was not deleted. Check your connection, then press Close and delete again.';

const bannerClass =
  'border-text-primary bg-card-bg text-text-primary mb-2 flex w-full flex-wrap items-center gap-2 rounded-[1.25rem] border px-3.5 py-2 text-sm';

/**
 * Where the open private chat is answered. Read again whenever that can change: a turn starts or ends
 * (the model may switch persona), the persona pill is used, or the window comes back into focus (a
 * model may have changed in another tab). The last answer stays on screen while the next one loads.
 */
function useChatPrivacy(sessionId: string | undefined): TrueForgeApi.ChatPrivacy | undefined {
  const server = useOptionalServer();
  const isRunning = useAuiState(state => state.thread.isRunning);
  const [reads, setReads] = useState(0);
  const [privacy, setPrivacy] = useState<{ sessionId: string; value: TrueForgeApi.ChatPrivacy } | undefined>();
  useEffect(() => {
    if (sessionId === undefined) return;
    const readAgain = () => setReads(count => count + 1);
    const unsubscribe = onPersonaMutationSettled(readAgain);
    window.addEventListener('focus', readAgain);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', readAgain);
    };
  }, [sessionId]);
  useEffect(() => {
    if (sessionId === undefined || server == null || !hasChatPrivacy(server)) return;
    let cancelled = false;
    void server
      .getChatPrivacy({ sessionId })
      .then(value => {
        if (!cancelled) setPrivacy({ sessionId, value });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [server, sessionId, isRunning, reads]);
  return privacy !== undefined && privacy.sessionId === sessionId ? privacy.value : undefined;
}

/**
 * Sits above the composer of a private chat: says what is kept and where the words go,
 * and holds Close and delete. On a new chat with Private chosen it says what that means.
 */
export function PrivateChatBanner() {
  const aui = useAui();
  const shell = useOptionalShellMode();
  const toaster = useToasterOptional();
  const sessionId = useAuiState(state => state.threadListItem.remoteId) ?? undefined;
  const framed = usePrivateChatFrame();
  const isOpenPrivateChat = sessionId !== undefined && framed;
  const privacy = useChatPrivacy(isOpenPrivateChat ? sessionId : undefined);
  const [closing, setClosing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (sessionId === undefined && framed) {
    return (
      <div data-slot="aui_private-chat-banner" className={bannerClass}>
        <Icon name="lock" className="size-3.5 shrink-0" />
        <span>{PRIVATE_CHAT_CHOICE_LINE}</span>
      </div>
    );
  }
  if (!isOpenPrivateChat) return null;

  const closeAndDelete = async () => {
    if (closing) return;
    setClosing(true);
    try {
      await aui.threadListItem().delete();
      forgetPrivateChat(sessionId);
      if (shell?.isComposerEnabled) {
        shell.openDraft();
      } else {
        await aui.threads().switchToNewThread();
      }
    } catch {
      toaster?.showError(new Error(CLOSE_FAILED_MESSAGE));
    } finally {
      setClosing(false);
      setConfirming(false);
    }
  };

  return (
    <div data-slot="aui_private-chat-banner" className={bannerClass}>
      <Icon name="lock" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{privateChatBannerLine(privacy)}</span>
      <button
        type="button"
        className={cn(
          auiButtonClass({ variant: 'ghost', size: 'small' }),
          'h-7 gap-1 rounded-full border border-text-primary px-2.5 text-sm font-normal',
        )}
        onClick={() => setConfirming(true)}
      >
        <Icon name="trash" className="size-3.5 shrink-0" />
        Close and delete
      </button>
      <Dialog
        open={confirming}
        onOpenChange={next => {
          if (!closing) setConfirming(next);
        }}
        aria-label="Close and delete this chat"
        className="max-w-md"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close and delete this chat?</DialogTitle>
            <p className="text-text-secondary text-sm">{PRIVATE_CHAT_DELETE_WARNING}</p>
          </DialogHeader>
        </DialogContent>
        <DialogFooter>
          <Button.Secondary type="button" disabled={closing} onClick={() => setConfirming(false)}>
            Keep
          </Button.Secondary>
          <Button.Destructive type="button" disabled={closing} onClick={() => void closeAndDelete()}>
            {closing ? 'Deleting' : 'Delete for good'}
          </Button.Destructive>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
