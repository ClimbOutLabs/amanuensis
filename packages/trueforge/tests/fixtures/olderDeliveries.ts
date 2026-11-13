/**
 * A deliveries section as the first draft of the feed wrote it: no level, no reason, no seen time, and channel
 * attempts in a shape that no longer reads. An import must still bring the items across, with plain defaults.
 */
export const OLDER_DELIVERIES_JSON = [
  {
    id: 'older-delivery-1',
    kind: 'reminder',
    text: 'Water the plants',
    created_at: '2026-10-20T09:00:00.000Z',
    link: { type: 'chat', session_id: 'older-chat' },
    attempts: [{ via: 'browser', ok: true }],
  },
  {
    id: 'older-delivery-2',
    kind: 'note',
    text: 'Your passport renewal form is ready',
    created_at: '2026-10-21T09:00:00.000Z',
    seen_at: '2026-10-21T10:00:00.000Z',
  },
] as const;
