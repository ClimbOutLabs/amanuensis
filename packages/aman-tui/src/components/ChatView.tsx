import { Box, Static, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatClient } from '../chatClient.js';
import { ChatView as ChatViewFold } from '../chatEvents.js';
import { BlockView, isFinalBlock } from './BlockView.js';

/**
 * One open chat. The saved events fold in first, then the person types and the
 * reply streams into the same view. A turn that ends held for approval says so
 * in plain words and points at the web app, where approvals are answered in
 * this step. Esc goes back to the chat list.
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
  const sendingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    client
      .loadHistory(sessionId)
      .then(events => {
        if (cancelled) {
          return;
        }
        for (const event of events) {
          fold.apply(event);
        }
        setLoaded(true);
        setVersion(version => version + 1);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'This chat could not be loaded.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, fold]);

  const send = (text: string): void => {
    if (sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    void (async () => {
      try {
        for await (const event of client.streamMessage(sessionId, text)) {
          fold.apply(event);
          setVersion(version => version + 1);
        }
      } catch {
        fold.settle();
        setSendError('The reply did not finish. Check your connection, then send your message again.');
        setVersion(version => version + 1);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    })();
  };

  useInput((inputChar, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (!loaded || loadError !== null) {
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
      {sendError !== null ? (
        <Box marginTop={1}>
          <Text color="red">{sendError}</Text>
        </Box>
      ) : null}
      {loaded && loadError === null ? (
        <Box marginTop={1}>
          <Text>
            <Text color="cyan">{'› '}</Text>
            {input}
            {sending ? <Text dimColor> (sending...)</Text> : null}
          </Text>
        </Box>
      ) : null}
      <Text dimColor>Esc goes back to your chats.</Text>
    </Box>
  );
}
