'use client';

import { useChatConnection } from '../hooks/useForegroundEventSync.js';
import { useSlot } from '../theme/SlotsProvider.js';

const RECONNECTING_TEXT = 'Reconnecting…';
const CONNECTION_LOST_TEXT = 'Connection lost. Check your network, then tap Retry.';

/** A quiet line while the chat reconnects; one plain next step only when reconnecting keeps failing. */
export function ConnectionStatusContainer() {
  const MessageErrorBanner = useSlot('MessageErrorBanner');
  const { status, retry } = useChatConnection();

  if (status === 'reconnecting') {
    return (
      <p data-role="host-connection-status" role="status" className="text-text-secondary mt-2 px-1 text-sm">
        {RECONNECTING_TEXT}
      </p>
    );
  }
  if (status === 'lost') {
    return (
      <div data-role="host-connection-status">
        <MessageErrorBanner message={CONNECTION_LOST_TEXT} action={{ label: 'Retry', onClick: retry }} />
      </div>
    );
  }
  return null;
}
