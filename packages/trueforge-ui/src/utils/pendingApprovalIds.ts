type ApprovalRef = {
  id?: string;
  approved?: boolean;
  resolution?: string;
};

type ToolCallPart = {
  type: string;
  approval?: ApprovalRef;
  messages?: readonly {
    role: string;
    content: readonly ToolCallPart[];
  }[];
};

type MessageLike = {
  role: string;
  content: string | readonly ToolCallPart[];
};

/**
 * Ids of the approvals a message still waits on, sub-agent calls included. Only the newest message
 * can be answered, so callers pass that one; older cards are expired.
 */
export function pendingApprovalIdsOf(message: MessageLike | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (message === undefined || message.role !== 'assistant' || typeof message.content === 'string') return ids;

  function walk(content: readonly ToolCallPart[]): void {
    for (const part of content) {
      if (part.type !== 'tool-call') continue;
      const approval = part.approval;
      if (approval?.id !== undefined && approval.approved === undefined && approval.resolution === undefined) {
        ids.add(approval.id);
      }
      for (const nested of part.messages ?? []) {
        if (nested.role === 'assistant') walk(nested.content);
      }
    }
  }

  walk(message.content);
  return ids;
}
