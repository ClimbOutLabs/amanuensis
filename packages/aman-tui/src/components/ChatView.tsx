import type { HeldActionDecision, HeldActionOutcome } from '@truefoundry/trueforge-chat';
import { Box, Static, Text, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  APPROVED_OUTCOME_TEXT,
  DENIED_TEXT,
  alwaysAllowOffered,
  approvalLines,
  describeAnswerFailure,
  type PendingApproval,
} from '../approvals.js';
import type { ChatClient } from '../chatClient.js';
import { ChatView as ChatViewFold } from '../chatEvents.js';
import { chatErrorLine } from '../serverErrors.js';
import { ApprovalPanel, approvalPageSize, approvalScrollLimit } from './ApprovalPanel.js';
import { BlockView, isFinalBlock } from './BlockView.js';

const SEND_FAILED_LINE = 'The reply did not finish. Check your connection, then send your message again.';
const STOPPED_LINE = 'This reply was stopped.';

/**
 * One open chat. The saved events fold in first, then the person types and the
 * reply streams into the same view. When a turn holds an action, the whole
 * action is shown in the approval view below the chat and answered there, with
 * its own keys: Enter sends messages and never approves. Esc stops a reply
 * while one is streaming, and goes back to the chat list otherwise. A dropped
 * connection says so in plain words while the rejoin runs, and R retries the
 * rejoin at once.
 */
export function ChatView({
  client,
  sessionId,
  title,
  speakerName,
  webAddress,
  onBack,
}: {
  client: ChatClient;
  sessionId: string;
  title: string;
  speakerName: string;
  webAddress: string;
  onBack: () => void;
}) {
  const fold = useMemo(() => new ChatViewFold(webAddress), [webAddress]);
  const [, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  const sendingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const { stdout } = useStdout();

  const bump = useCallback(() => {
    setVersion(version => version + 1);
  }, []);

  const refreshTipPendings = useCallback(async (): Promise<void> => {
    try {
      const approvals = await client.pendingApprovals(sessionId);
      for (const approval of approvals) {
        fold.registerPending(approval);
      }
      if (approvals.length > 0) {
        bump();
      }
    } catch {
      // The folded events are the primary source for waiting actions. A
      // failed tip read leaves the view exactly as the events left it.
    }
  }, [client, sessionId, fold, bump]);

  useEffect(() => {
    let cancelled = false;
    client
      .loadHistory(sessionId)
      .then(async events => {
        if (cancelled) {
          return;
        }
        for (const event of events) {
          fold.apply(event);
        }
        setLoaded(true);
        bump();
        await refreshTipPendings();
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const line = chatErrorLine(error, 'This chat could not be loaded.');
          setLoadError(
            line.keyRefused ? `${line.message} Pair again with: aman-tui login ${webAddress}` : line.message,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, fold, webAddress, bump, refreshTipPendings]);

  const pending = fold.pendingApprovals();
  const activeApproval = sending ? undefined : pending[0];
  const activeLineCount = useMemo(
    () => (activeApproval === undefined ? 0 : approvalLines(activeApproval, speakerName).length),
    [activeApproval, speakerName],
  );
  const pageSize = approvalPageSize(stdout?.rows ?? 40);
  const scrollLimit = approvalScrollLimit(activeLineCount, pageSize);

  // A new waiting action starts at the top of its card, with no answer error carried over.
  const activeToolCallId = activeApproval?.toolCallId;
  useEffect(() => {
    setScroll(0);
    setAnswerError(null);
  }, [activeToolCallId]);

  const streamHooks = useMemo(
    () => ({
      onConnectionLost: () => {
        setConnectionLost(true);
      },
    }),
    [],
  );

  const send = (text: string): void => {
    if (sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    stopRequestedRef.current = false;
    void (async () => {
      let sawDone = false;
      try {
        for await (const event of client.streamMessage(sessionId, text, streamHooks)) {
          if (event.type === 'turn.done') {
            sawDone = true;
          }
          setConnectionLost(false);
          fold.apply(event);
          bump();
        }
      } catch (error) {
        fold.settle();
        if (!stopRequestedRef.current) {
          const line = chatErrorLine(error, SEND_FAILED_LINE);
          setSendError(
            line.keyRefused ? `${line.message} Pair again with: aman-tui login ${webAddress}` : line.message,
          );
        }
        bump();
      } finally {
        if (stopRequestedRef.current && !sawDone) {
          fold.addNote(STOPPED_LINE);
          bump();
        }
        setConnectionLost(false);
        sendingRef.current = false;
        setSending(false);
      }
    })();
  };

  const answer = (approval: PendingApproval, decision: HeldActionDecision): void => {
    if (sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setAnswerError(null);
    setSendError(null);
    stopRequestedRef.current = false;
    void (async () => {
      try {
        const generator = client.answerApproval(sessionId, approval, decision, streamHooks);
        let outcome: HeldActionOutcome = 'unclear';
        let step = await generator.next();
        while (!step.done) {
          setConnectionLost(false);
          fold.apply(step.value);
          bump();
          step = await generator.next();
        }
        outcome = step.value;
        fold.resolvePending(approval.toolCallId);
        if (!stopRequestedRef.current) {
          fold.addNote(decision === 'deny' ? DENIED_TEXT : APPROVED_OUTCOME_TEXT[outcome]);
        }
        bump();
        await refreshTipPendings();
      } catch (error) {
        const failure = describeAnswerFailure(error, speakerName);
        if (failure.kind === 'key-refused') {
          fold.resolvePending(approval.toolCallId);
          setSendError(`${failure.message} Pair again with: aman-tui login ${webAddress}`);
        } else if (failure.kind === 'refused') {
          fold.resolvePending(approval.toolCallId);
          fold.addNote(failure.message);
        } else {
          setAnswerError(failure.message);
        }
        bump();
      } finally {
        setConnectionLost(false);
        sendingRef.current = false;
        setSending(false);
      }
    })();
  };

  const stop = (): void => {
    stopRequestedRef.current = true;
    void client.stopTurn(sessionId).catch(() => undefined);
  };

  useInput((inputChar, key) => {
    if (key.escape) {
      if (sendingRef.current) {
        stop();
      } else {
        onBack();
      }
      return;
    }
    if (!loaded || loadError !== null) {
      return;
    }
    if (activeApproval !== undefined && !sendingRef.current) {
      // The approval keys. Enter is not one of them: it sends chat messages,
      // so it must never also approve. Every other key does nothing here.
      if (key.upArrow) {
        setScroll(value => Math.max(0, value - 1));
        return;
      }
      if (key.downArrow) {
        setScroll(value => Math.min(scrollLimit, value + 1));
        return;
      }
      if (key.pageUp) {
        setScroll(value => Math.max(0, value - pageSize));
        return;
      }
      if (key.pageDown) {
        setScroll(value => Math.min(scrollLimit, value + pageSize));
        return;
      }
      if (inputChar === 'a') {
        answer(activeApproval, 'approve');
        return;
      }
      if (inputChar === 'A' && alwaysAllowOffered(activeApproval)) {
        answer(activeApproval, 'always_allow');
        return;
      }
      if (inputChar === 'd') {
        answer(activeApproval, 'deny');
        return;
      }
      return;
    }
    if (connectionLost && inputChar === 'r') {
      client.retryConnectionNow();
      return;
    }
    if (key.return) {
      const text = input.trim();
      if (text !== '' && !sendingRef.current) {
        setInput('');
        send(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput(value => value.slice(0, -1));
      return;
    }
    if (inputChar !== '' && !key.ctrl && !key.meta) {
      setInput(value => value + inputChar);
    }
  });

  const blocks = fold.blocks;
  let staticCount = 0;
  while (staticCount < blocks.length) {
    const block = blocks[staticCount];
    if (block === undefined || !isFinalBlock(block)) {
      break;
    }
    staticCount += 1;
  }
  const staticBlocks = blocks.slice(0, staticCount);
  const dynamicBlocks = blocks.slice(staticCount);

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {!loaded && loadError === null ? <Text>Loading this chat...</Text> : null}
      {loadError !== null ? <Text color="red">{loadError}</Text> : null}
      <Static items={staticBlocks}>
        {block => <BlockView key={block.id} block={block} speakerName={speakerName} />}
      </Static>
      {dynamicBlocks.map(block => (
        <BlockView key={block.id} block={block} speakerName={speakerName} />
      ))}
      {connectionLost ? (
        <Box marginTop={1}>
          <Text color="yellow">The connection was lost. Trying to rejoin the reply. Press R to retry now.</Text>
        </Box>
      ) : null}
      {sendError !== null ? (
        <Box marginTop={1}>
          <Text color="red">{sendError}</Text>
        </Box>
      ) : null}
      {loaded && loadError === null && activeApproval !== undefined ? (
        <ApprovalPanel
          approval={activeApproval}
          assistantName={speakerName}
          scroll={scroll}
          answerError={answerError}
          waitingCount={pending.length}
        />
      ) : null}
      {loaded && loadError === null && activeApproval === undefined ? (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan">{'› '}</Text>
            {input}
            {sending ? <Text dimColor> (sending...)</Text> : null}
          </Text>
        </Box>
      ) : null}
      <Text dimColor>{sending ? 'Esc stops the reply.' : 'Esc goes back to your chats.'}</Text>
    </Box>
  );
}
