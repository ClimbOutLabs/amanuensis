'use client';

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type RespondToToolApprovalOptions,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ReactNode } from 'react';

/** Test-only harness driving a real assistant-ui runtime from plain message fixtures. */
export function RuntimeHarness({
  messages,
  isRunning = false,
  isLoading = false,
  threadId,
  remoteId,
  onRespondToToolApproval,
  onEdit,
  onNew = async () => {},
  children,
}: {
  messages: ThreadMessageLike[];
  isRunning?: boolean;
  isLoading?: boolean;
  /** The runtime's own id for the thread (`threadListItem.id`). Only takes effect together with
   *  the default `remoteId` behavior of `useExternalStoreRuntime`'s thread-list adapter; omit
   *  both to keep the single fixed thread id every other test relies on. */
  threadId?: string;
  /** `threadListItem.remoteId` for `threadId`, as after the runtime learns the server's id for a
   *  conversation created locally. Only meaningful together with `threadId`. */
  remoteId?: string;
  onRespondToToolApproval?: (options: RespondToToolApprovalOptions) => void;
  onEdit?: (message: AppendMessage) => Promise<void>;
  onNew?: (message: AppendMessage) => Promise<void>;
  children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    isLoading,
    convertMessage: message => message,
    onNew,
    onEdit,
    onRespondToToolApproval,
    adapters:
      threadId === undefined
        ? undefined
        : {
            threadList: {
              threadId,
              threads: [{ status: 'regular', id: threadId, remoteId }],
            },
          },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
