import { z } from '@hono/zod-openapi';

/** The one state both account cards show; the schema is shared so a new state reaches Email and Calendar together. */
export const ConnectorAccountStateSchema = z
  .enum(['connected', 'not_connected', 'sign_in_stopped', 'not_working'])
  .describe(
    'Connected, not connected, connected but the saved sign-in no longer works, or saved but the server cannot be reached right now.',
  );
