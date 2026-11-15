import { Box, Text, useStdout } from 'ink';
import { useMemo } from 'react';

import { approvalLines, approveChoiceLabel, denyChoiceLabel, type PendingApproval } from '../approvals.js';

/** How far the approval view can scroll, and the page size it scrolls by. */
export function approvalScrollLimit(lineCount: number, pageSize: number): number {
  return Math.max(0, lineCount - pageSize);
}

/** The lines of an approval the view shows at once, leaving room for the chat around it. */
export function approvalPageSize(terminalRows: number): number {
  return Math.max(6, terminalRows - 12);
}

/**
 * One action waiting for an answer, shown whole before any answer is
 * possible. The lines are the card's own lines, every one of them: the view
 * shows one window of them and scrolls, so a long email body is read in full
 * here, never cut to fit. The choices sit under the window. Enter never
 * answers here; it sends chat messages, so answering takes its own keys.
 */
export function ApprovalPanel({
  approval,
  assistantName,
  scroll,
  answerError,
  waitingCount,
}: {
  approval: PendingApproval;
  assistantName: string;
  scroll: number;
  answerError: string | null;
  waitingCount: number;
}) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;
  const pageSize = approvalPageSize(rows);
  const lines = useMemo(() => approvalLines(approval, assistantName), [approval, assistantName]);
  const limit = approvalScrollLimit(lines.length, pageSize);
  const offset = Math.min(scroll, limit);
  const visible = lines.slice(offset, offset + pageSize);
  const approveLabel = approveChoiceLabel(approval.card);
  const denyLabel = denyChoiceLabel(approval.card);

  return (
    <Box borderStyle="round" flexDirection="column" marginTop={1} paddingX={1}>
      <Text bold>Waiting for your OK</Text>
      {waitingCount > 1 ? (
        <Text dimColor>{`${String(waitingCount)} actions are waiting. This is the first.`}</Text>
      ) : null}
      {offset > 0 ? <Text dimColor>More above. Scroll with the up and down arrow keys.</Text> : null}
      {visible.map((line, index) => (
        <Text key={`${String(offset + index)}-${line.slice(0, 24)}`}>{line === '' ? ' ' : line}</Text>
      ))}
      {offset < limit ? (
        <Text dimColor>More below. Scroll with the up and down arrow keys to read all of it before you answer.</Text>
      ) : null}
      {answerError !== null ? (
        <Box marginTop={1}>
          <Text color="red">{answerError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text>
          <Text bold>{`A: ${approveLabel}`}</Text>
          {approval.canAlwaysAllow ? <Text>{'   Shift+A: Always allow everywhere'}</Text> : null}
          <Text>{`   D: ${denyLabel}`}</Text>
          <Text dimColor>{'   Up and down arrows scroll   Esc leaves it for later'}</Text>
        </Text>
      </Box>
    </Box>
  );
}
