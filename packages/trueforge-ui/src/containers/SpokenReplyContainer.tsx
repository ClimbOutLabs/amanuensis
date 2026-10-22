'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import { useEffect, useRef } from 'react';

import { useOptionalSentinelState, type SentinelState } from '../sentinel/SentinelStateProvider.js';
import { isSpeechOutputSupported, speakText, useSpeakingKey } from '../utils/speechOutput.js';
import { readSpeechVoiceURI, useSpeakVoiceReplies } from '../utils/speechReplyPreferences.js';
import {
  approvalSpeechLine,
  finalAnswerSpeech,
  limitSpeechWords,
  pendingApprovalCallIds,
  type SpeechContentPart,
} from '../utils/speechText.js';
import { takeSpokenReply } from '../utils/voiceTurn.js';

type SpeakableMessage = {
  readonly id: string;
  readonly role: string;
  readonly status?: { readonly type: string };
  readonly content: readonly SpeechContentPart[];
};

function lastAssistantMessage(messages: readonly SpeakableMessage[]): SpeakableMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return undefined;
}

/** One short line for a reply that waits on an approval; the approval itself stays on screen. */
function approvalLine(content: readonly SpeechContentPart[], sentinel: SentinelState | null): string | undefined {
  const callIds = pendingApprovalCallIds(content);
  if (callIds.length === 0) return undefined;
  for (const callId of callIds) {
    const info = sentinel?.approvalFor(callId);
    if (info !== undefined) return approvalSpeechLine(info.card.plain_what);
  }
  return approvalSpeechLine('');
}

/**
 * Reads the reply to a voice-sent message aloud once its turn finishes: the final answer, or one
 * short line when the turn waits for an approval. Speech never answers an approval.
 */
export function SpokenReplyContainer() {
  const isRunning = useThreadIsRunning();
  const sentinel = useOptionalSentinelState();
  const messages = useAuiState(s => s.thread.messages);
  const threadId = useAuiState(s => s.threadListItem.id);
  const { enabled } = useSpeakVoiceReplies();
  const speakingKey = useSpeakingKey();
  const wasRunning = useRef(isRunning);
  const runThreadId = useRef(threadId);
  // Set when a voice-armed turn finishes in the chat it started in; the reply is read once its
  // message is final, because the runtime still holds the optimistic running message in the render
  // where the turn ends.
  const replyDue = useRef(false);

  useEffect(() => {
    const finished = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (isRunning) {
      replyDue.current = false;
      runThreadId.current = threadId;
      return;
    }
    if (finished && takeSpokenReply()) replyDue.current = true;
  }, [isRunning, threadId]);

  useEffect(() => {
    if (!replyDue.current || isRunning) return;
    const message = lastAssistantMessage(messages);
    if (message === undefined || message.status?.type === 'running') return;
    replyDue.current = false;
    // Switching chats ends a run as seen here too; only the chat the voice turn started in is read.
    if (runThreadId.current !== threadId) return;
    if (!enabled || !isSpeechOutputSupported()) return;
    const text = approvalLine(message.content, sentinel) ?? limitSpeechWords(finalAnswerSpeech(message.content));
    speakText({ key: message.id, text, voiceURI: readSpeechVoiceURI() });
  }, [isRunning, messages, enabled, sentinel, threadId]);

  return (
    <span aria-live="polite" className="sr-only" data-testid="spoken-reply-announcement">
      {speakingKey !== null ? 'Reading the answer aloud.' : ''}
    </span>
  );
}
