import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import type { SavedInstance } from '../instances.js';

/** The quick switch between paired instances: pick the one the app should open. */
export function InstanceSwitcher({
  instances,
  activeAddress,
  onPick,
  onCancel,
}: {
  instances: SavedInstance[];
  activeAddress: string;
  onPick: (instance: SavedInstance) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      instances.findIndex(instance => instance.address === activeAddress),
    ),
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    } else if (key.upArrow || input === 'k') {
      setSelected(index => Math.max(0, index - 1));
    } else if (key.downArrow || input === 'j') {
      setSelected(index => Math.min(instances.length - 1, index + 1));
    } else if (key.return) {
      const instance = instances[selected];
      if (instance !== undefined) {
        onPick(instance);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Switch instance</Text>
      {instances.map((instance, index) => (
        <Text key={instance.address} inverse={index === selected}>
          {instance.address}
          {instance.address === activeAddress ? '  (current)' : ''}
        </Text>
      ))}
      <Text dimColor>Enter switches. Esc goes back.</Text>
    </Box>
  );
}
