import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import type { ChatClient, ChatSummary } from '../chatClient.js';
import { chatErrorLine } from '../serverErrors.js';
import { lastActiveWord } from '../words.js';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string; keyRefused: boolean }
  | { status: 'ready'; chats: ChatSummary[] };

/**
 * The chat list: the person's chats, newest first, with the persona and when
 * each was last active. Enter opens one, N starts a new chat, S switches
 * instance when more than one is paired, Q leaves.
 */
export function ChatList({
  client,
  address,
  instanceCount,
  onOpen,
  onSwitchInstance,
  onExit,
}: {
  client: ChatClient;
  address: string;
  instanceCount: number;
  onOpen: (chat: ChatSummary) => void;
  onSwitchInstance: () => void;
  onExit: () => void;
}) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    client
      .listChats()
      .then(chats => {
        if (!cancelled) {
          setState({ status: 'ready', chats });
          setSelected(0);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const line = chatErrorLine(error, 'The chats could not be loaded.');
          setState({ status: 'error', message: line.message, keyRefused: line.keyRefused });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadTick]);

  useInput((input, key) => {
    // The screen names these keys with capitals, and a terminal sends the
    // capital when Shift is held or Caps Lock is on, so both cases answer.
    if (input === 'q' || input === 'Q') {
      onExit();
      return;
    }
    if (state.status !== 'ready') {
      if (input === 'r' || input === 'R') {
        setReloadTick(tick => tick + 1);
      }
      return;
    }
    const chats = state.chats;
    if (key.upArrow || input === 'k') {
      setSelected(index => Math.max(0, index - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected(index => Math.min(chats.length - 1, index + 1));
    } else if (key.return) {
      const chat = chats[selected];
      if (chat !== undefined) {
        onOpen(chat);
      }
    } else if (input === 'n' || input === 'N') {
      client
        .createChat()
        .then(chat => onOpen(chat))
        .catch((error: unknown) => {
          const line = chatErrorLine(error, 'A new chat could not be started.');
          setState({ status: 'error', message: line.message, keyRefused: line.keyRefused });
        });
    } else if ((input === 's' || input === 'S') && instanceCount > 1) {
      onSwitchInstance();
    } else if (input === 'r' || input === 'R') {
      setReloadTick(tick => tick + 1);
    }
  });

  const now = new Date();
  return (
    <Box flexDirection="column">
      <Text bold>Aman</Text>
      <Text dimColor>{address}</Text>
      {state.status === 'loading' ? <Text>Loading your chats...</Text> : null}
      {state.status === 'error' ? (
        <Box flexDirection="column">
          <Text color="red">{state.message}</Text>
          {state.keyRefused ? (
            <Text dimColor>Pair again with: aman-tui login {address}, or press Q to leave.</Text>
          ) : (
            <Text dimColor>Press R to try again, or Q to leave.</Text>
          )}
        </Box>
      ) : null}
      {state.status === 'ready' && state.chats.length === 0 ? (
        <Box flexDirection="column">
          <Text>No chats yet.</Text>
          <Text dimColor>Press N to start a new chat, or Q to leave.</Text>
        </Box>
      ) : null}
      {state.status === 'ready'
        ? state.chats.map((chat, index) => (
            <Text key={chat.id} inverse={index === selected}>
              {chat.title}
              {chat.personaName === null ? '' : `  (${chat.personaName})`}
              {`  ${lastActiveWord(chat.updatedAt, now)}`}
            </Text>
          ))
        : null}
      {state.status === 'ready' && state.chats.length > 0 ? (
        <Text dimColor>
          Enter opens a chat. N starts a new one.{instanceCount > 1 ? ' S switches instance.' : ''} Q leaves.
        </Text>
      ) : null}
    </Box>
  );
}
