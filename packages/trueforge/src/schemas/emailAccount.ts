import { z } from '@hono/zod-openapi';
import { ConnectorAccountStateSchema } from './connectorAccount';

const MailServerModeSchema = z
  .enum(['ssl', 'starttls'])
  .describe('How the server is reached: direct TLS, or plain first and upgraded with STARTTLS.');

export const EmailProviderSchema = z
  .object({
    key: z.string().describe('Stable provider key, such as gmail or other.'),
    name: z.string().describe('The name the person sees in the provider picker.'),
    imap_host: z.string().describe('Incoming mail server.'),
    imap_port: z.number().int().describe('Incoming mail port.'),
    imap_mode: MailServerModeSchema,
    smtp_host: z.string().describe('Outgoing mail server.'),
    smtp_port: z.number().int().describe('Outgoing mail port.'),
    smtp_mode: MailServerModeSchema,
    help_url: z
      .string()
      .nullable()
      .describe("The provider's own help page for making an app password; null when none could be checked."),
    help_hint: z.string().describe('One plain sentence on how to get an app password.'),
  })
  .openapi('EmailProvider');

export const EmailAccountEntrySchema = z
  .object({
    address: z.string().describe('The account address.'),
    provider_key: z.string().describe('The provider of this account, worked out from its servers.'),
    state: ConnectorAccountStateSchema,
    is_default: z.boolean().describe('Whether this is the account new mail goes out from.'),
    imap_host: z.string().describe('Incoming mail server.'),
    imap_port: z.number().int().describe('Incoming mail port.'),
    imap_mode: MailServerModeSchema,
    smtp_host: z.string().describe('Outgoing mail server.'),
    smtp_port: z.number().int().describe('Outgoing mail port.'),
    smtp_mode: MailServerModeSchema,
  })
  .openapi('EmailAccountEntry');

export const EmailAccountStatusSchema = z
  .object({
    available: z
      .boolean()
      .describe('Whether this instance has the Email connector at all; when false, no card is shown.'),
    state: ConnectorAccountStateSchema,
    address: z.string().nullable().describe('The default account address; null when none is connected.'),
    provider_key: z
      .string()
      .describe('The provider of the default account, worked out from its servers; the picker default otherwise.'),
    accounts: z.array(EmailAccountEntrySchema).describe('Every connected account, in saved order.'),
    default_address: z.string().nullable().describe('The account new mail goes out from; null when none is connected.'),
    providers: z.array(EmailProviderSchema).describe('The provider picker table, in display order.'),
  })
  .openapi('EmailAccountStatus');

export const GetEmailAccountResponseSchema = z
  .object({ data: EmailAccountStatusSchema })
  .openapi('GetEmailAccountResponse');

export const SaveEmailAccountRequestSchema = z
  .object({
    provider_key: z.string().describe('The picked provider key, or other for typed servers.'),
    address: z.string().describe('The email address to connect.'),
    password: z
      .string()
      .describe('The app password. Write-only: it is checked and passed to the sidecar, never stored or returned.'),
    imap_host: z.string().optional().describe('Incoming server, only for the other provider.'),
    imap_port: z.number().int().optional().describe('Incoming port, only for the other provider.'),
    smtp_host: z.string().optional().describe('Outgoing server, only for the other provider.'),
    smtp_port: z.number().int().optional().describe('Outgoing port, only for the other provider.'),
  })
  .openapi('SaveEmailAccountRequest');

export const SaveEmailAccountResponseSchema = z
  .object({ data: EmailAccountStatusSchema })
  .openapi('SaveEmailAccountResponse');

export const RemoveEmailAccountRequestSchema = z
  .object({
    address: z
      .string()
      .optional()
      .describe('The one account to remove; without it, every connected account is removed.'),
  })
  .openapi('RemoveEmailAccountRequest');

export const RemoveEmailAccountResponseSchema = z
  .object({ data: EmailAccountStatusSchema })
  .openapi('RemoveEmailAccountResponse');

export const SetDefaultEmailAccountRequestSchema = z
  .object({
    address: z.string().describe('The connected account to make the default.'),
  })
  .openapi('SetDefaultEmailAccountRequest');

export const SetDefaultEmailAccountResponseSchema = z
  .object({ data: EmailAccountStatusSchema })
  .openapi('SetDefaultEmailAccountResponse');

export type EmailAccountStatus = z.infer<typeof EmailAccountStatusSchema>;
export type SaveEmailAccountRequest = z.infer<typeof SaveEmailAccountRequestSchema>;
export type RemoveEmailAccountRequest = z.infer<typeof RemoveEmailAccountRequestSchema>;
export type SetDefaultEmailAccountRequest = z.infer<typeof SetDefaultEmailAccountRequestSchema>;
