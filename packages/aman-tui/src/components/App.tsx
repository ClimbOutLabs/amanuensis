import { Box, Text, useApp } from 'ink';
import { useEffect, useMemo, useState } from 'react';

import { createChatClient, type ChatClient, type ChatSummary } from '../chatClient.js';
import { activeInstance, loadInstanceStore, saveInstanceStore, type SavedInstance } from '../instances.js';
import { keyStoreForKind } from '../keyStore.js';
import { ChatList } from './ChatList.js';
import { ChatView } from './ChatView.js';
import { InstanceSwitcher } from './InstanceSwitcher.js';

type Screen = { name: 'list' } | { name: 'chat'; chat: ChatSummary } | { name: 'switch' };

type Ready =
  | { status: 'resolving' }
  | { status: 'no-instance' }
  | { status: 'key-missing'; instance: SavedInstance }
  | { status: 'ready'; instance: SavedInstance; terminalKey: string };

/**
 * The terminal app: resolves the active paired instance and its key, then shows
 * the chat list, one open chat, or the instance switcher. Pairing itself is the
 * login command, so a terminal with no pairing is told the one thing to do.
 */
export function App({ configDir }: { configDir: string }) {
  const { exit } = useApp();
  const [ready, setReady] = useState<Ready>({ status: 'resolving' });
  const [screen, setScreen] = useState<Screen>({ name: 'list' });
  const [storeVersion, setStoreVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = loadInstanceStore(configDir);
      const instance = activeInstance(store);
      if (instance === undefined) {
        if (!cancelled) {
          setReady({ status: 'no-instance' });
        }
        return;
      }
      let key: string | undefined;
      try {
        key = await keyStoreForKind(instance.keyStore, { configDir }).get(instance.address);
      } catch {
        // A key store that cannot be read leaves the key as good as gone, and
        // the key-missing screen below already names the remedy for both.
        key = undefined;
      }
      if (cancelled) {
        return;
      }
      setReady(
        key === undefined ? { status: 'key-missing', instance } : { status: 'ready', instance, terminalKey: key },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [configDir, storeVersion]);

  const client: ChatClient | null = useMemo(() => {
    if (ready.status !== 'ready') {
      return null;
    }
    return createChatClient({ baseUrl: ready.instance.address, token: ready.terminalKey });
  }, [ready]);

  if (ready.status === 'resolving') {
    return <Text>Starting...</Text>;
  }
  if (ready.status === 'no-instance') {
    return (
      <Box flexDirection="column">
        <Text>No Aman is paired with this terminal yet.</Text>
        <Text>Pair one with: aman-tui login &lt;address&gt;</Text>
      </Box>
    );
  }
  if (ready.status === 'key-missing') {
    return (
      <Box flexDirection="column">
        <Text>The key for {ready.instance.address} is not on this computer any more.</Text>
        <Text>Pair again with: aman-tui login {ready.instance.address}</Text>
      </Box>
    );
  }
  if (client === null) {
    return <Text>Starting...</Text>;
  }

  const store = loadInstanceStore(configDir);
  if (screen.name === 'switch') {
    return (
      <InstanceSwitcher
        instances={store.instances}
        activeAddress={ready.instance.address}
        onPick={instance => {
          saveInstanceStore(configDir, { instances: store.instances, activeAddress: instance.address });
          setScreen({ name: 'list' });
          setStoreVersion(version => version + 1);
        }}
        onCancel={() => setScreen({ name: 'list' })}
      />
    );
  }
  if (screen.name === 'chat') {
    return (
      <ChatView
        key={screen.chat.id}
        client={client}
        sessionId={screen.chat.id}
        title={screen.chat.title}
        speakerName={screen.chat.personaName ?? 'Aman'}
        webAddress={ready.instance.address}
        onBack={() => setScreen({ name: 'list' })}
      />
    );
  }
  return (
    <ChatList
      client={client}
      address={ready.instance.address}
      instanceCount={store.instances.length}
      onOpen={chat => setScreen({ name: 'chat', chat })}
      onSwitchInstance={() => setScreen({ name: 'switch' })}
      onExit={() => exit()}
    />
  );
}
