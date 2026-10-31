'use client';

import type { PartState } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import { ROOT_THREAD_ID, useTrueFoundryReload } from '@truefoundry/assistant-ui-runtime';
import { changeRequestReason, changeRequestText } from '@truefoundry/trueforge-core/core/permissions/changeRequest';
import { useState } from 'react';

import { useOptionalPersonalization } from '../components/PersonalizationContext.js';
import { useActiveSessionCanManage } from '../hooks/useResourcePermissions.js';
import { hasSessionResync, type HeldActionDecision } from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { offersChangeIt } from '../sentinel/approvalChoices.js';
import { HeldActionCard, type HeldActionStatus } from '../sentinel/HeldActionCard.js';
import { describeHeldAnswerFailure } from '../sentinel/heldActionErrors.js';
import { NeedsYourOk, NotSavedNote } from '../sentinel/NeedsYourOk.js';
import { useOptionalSentinelState } from '../sentinel/SentinelStateProvider.js';
import type { SentinelApprovalInfo } from '../sentinel/types.js';
import { useOptionalServer } from '../server/ServerContext.js';
import { useSlot } from '../theme/SlotsProvider.js';
import { assistantDisplayName } from '../utils/assistantName.js';

type Local = Exclude<HeldActionStatus, { kind: 'waiting' }>;

/**
 * The "Needs your OK" block at the end of a finished assistant message: one card for each action the
 * run held, built from the server's cards and never from the model's text. Answering asks the server
 * to run exactly the held call, or drop it, shows what became of it, and reloads the chat.
 */
export function NeedsYourOkContainer({ parts }: { parts: readonly PartState[] }): React.JSX.Element | null {
  const UserMessageBubble = useSlot('UserMessageBubble');
  const sentinel = useOptionalSentinelState();
  const server = useOptionalServer();
  const reload = useTrueFoundryReload();
  const canManage = useActiveSessionCanManage();
  const sessionId = useAuiState(state => state.threadListItem.remoteId ?? undefined);
  const messageStatus = useAuiState(state => state.message.status?.type);
  const [local, setLocal] = useState<ReadonlyMap<string, Local>>(new Map());
  const assistantName = assistantDisplayName(useOptionalPersonalization()?.profile?.assistant_name);

  if (sentinel == null) return null;
  const toolCallIds = parts.flatMap(part => (part.type === 'tool-call' ? [part.toolCallId] : []));
  const held = toolCallIds.flatMap(id => {
    const info = sentinel.heldFor(id);
    return info === undefined ? [] : [info];
  });
  const notSavedCount = toolCallIds.filter(id => sentinel.wasNotSaved(id)).length;
  // While the run is still going its newest turn cannot be answered, so the block waits for the end.
  if ((held.length === 0 && notSavedCount === 0) || messageStatus === 'running') return null;
  if (held.length === 0) return <NotSavedNote count={notSavedCount} />;

  const setStatus = (toolCallId: string, next: Local | undefined) =>
    setLocal(previous => {
      const copy = new Map(previous);
      if (next === undefined) copy.delete(toolCallId);
      else copy.set(toolCallId, next);
      return copy;
    });

  const answer = async (info: SentinelApprovalInfo, decision: HeldActionDecision, reason?: string) => {
    if (server == null || !hasSessionResync(server) || sessionId == null) return;
    setStatus(info.toolCallId, { kind: 'working' });
    try {
      const outcome = await server.answerHeldAction({
        sessionId,
        threadId: info.threadId ?? ROOT_THREAD_ID,
        toolCallId: info.toolCallId,
        answer: decision,
        reason,
      });
      sentinel.recordAnswer(info.toolCallId, decision === 'deny' ? 'denied' : 'approved');
      const words = changeRequestText(reason);
      if (words !== undefined) sentinel.recordChangeRequest(info.toolCallId, words);
      setStatus(info.toolCallId, decision === 'deny' ? undefined : { kind: 'approved', outcome });
      reload();
    } catch (error) {
      console.error('Held action could not be answered', error);
      const failure = describeHeldAnswerFailure(error, assistantName);
      setStatus(
        info.toolCallId,
        failure.kind === 'refused'
          ? failure.expired
            ? { kind: 'expired' }
            : { kind: 'refused', message: failure.message }
          : { kind: 'failed', message: failure.message },
      );
    }
  };

  const changeRequestNote = (toolCallId: string) => {
    const words = sentinel.changeRequestFor(toolCallId);
    return words === undefined ? undefined : <UserMessageBubble text={words} />;
  };

  const statusOf = (info: SentinelApprovalInfo): HeldActionStatus => {
    const mine = local.get(info.toolCallId);
    if (mine !== undefined) return mine;
    const answered = sentinel.answerFor(info.toolCallId);
    if (answered === 'denied') return { kind: 'denied' };
    if (answered === 'approved') return { kind: 'approved_earlier' };
    const expiresAt = info.held?.expiresAt;
    return expiresAt != null && Date.parse(expiresAt) <= Date.now() ? { kind: 'expired' } : { kind: 'waiting' };
  };

  return (
    <NeedsYourOk notSavedCount={notSavedCount} assistant={assistantName}>
      {held.map(info => (
        <HeldActionCard
          key={info.toolCallId}
          card={info.card}
          status={statusOf(info)}
          alwaysAllowOffered={info.alwaysAllowOffered === true}
          disabled={!canManage || server == null || !hasSessionResync(server)}
          onApprove={() => void answer(info, 'approve')}
          onAlwaysAllow={() => void answer(info, 'always_allow')}
          onDeny={() => void answer(info, 'deny')}
          onChangeRequest={
            offersChangeIt(info.card) ? text => void answer(info, 'deny', changeRequestReason(text)) : undefined
          }
          changeRequestNote={changeRequestNote(info.toolCallId)}
        />
      ))}
    </NeedsYourOk>
  );
}
