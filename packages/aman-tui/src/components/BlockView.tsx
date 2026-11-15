import { Box, Text } from 'ink';

import type { ViewBlock } from '../chatEvents.js';
import { outcomeWord } from '../words.js';

/** One block of a chat: a message, a tool card, or a plain note line. */
export function BlockView({ block, speakerName }: { block: ViewBlock; speakerName: string }) {
  switch (block.kind) {
    case 'user': {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>You</Text>
          <Text>{block.text}</Text>
        </Box>
      );
    }
    case 'assistant': {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            {speakerName}
          </Text>
          <Text>{block.text}</Text>
        </Box>
      );
    }
    case 'tool': {
      return (
        <Box borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
          <Text>
            {block.name}
            {'  '}
            <Text dimColor>{block.outcome === null ? 'Working...' : outcomeWord(block.outcome)}</Text>
          </Text>
          {block.detail === null ? null : <Text dimColor>{block.detail}</Text>}
        </Box>
      );
    }
    case 'note': {
      return (
        <Box marginTop={1}>
          <Text dimColor>{block.text}</Text>
        </Box>
      );
    }
  }
}

/** A block is final when nothing in it can still change, so it can scroll into history for good. */
export function isFinalBlock(block: ViewBlock): boolean {
  switch (block.kind) {
    case 'user':
    case 'note':
      return true;
    case 'assistant':
      return !block.streaming;
    case 'tool':
      // A tool waiting for approval is not final: its outcome still changes when the answer lands.
      return block.outcome !== null && block.outcome !== 'waiting_approval';
  }
}
