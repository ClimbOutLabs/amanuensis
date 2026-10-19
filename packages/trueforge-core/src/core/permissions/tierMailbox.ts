import { z } from '@hono/zod-openapi';

/** One recipient of an email: the name shown for it, or empty, and the address that mail goes to. */
export const Tier3MailboxSchema = z
  .object({
    name: z.string().describe('Display name of the recipient, or an empty string when it has none.'),
    address: z.string().describe('Email address the message is delivered to.'),
  })
  .describe('One email recipient: its name and its address.')
  .openapi('Tier3Mailbox');

export type Tier3Mailbox = z.infer<typeof Tier3MailboxSchema>;
