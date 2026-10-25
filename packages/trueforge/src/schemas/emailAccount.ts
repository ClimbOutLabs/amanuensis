import { z } from '@hono/zod-openapi';

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

export const EmailAccountStatusSchema = z
  .object({
    available: z
      .boolean()
      .describe('Whether this instance has the Email connector at all; when false, no card is shown.'),
    state: z
      .enum(['connected', 'not_connected', 'sign_in_stopped'])
      .describe('Connected, not connected, or connected but the saved sign-in no longer works.'),
    address: z.string().nullable().describe('The connected account address; null when none is connected.'),
    provider_key: z
      .string()
      .describe('The provider of the connected account, worked out from its servers; the picker default otherwise.'),
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

export const RemoveEmailAccountResponseSchema = z
  .object({ data: EmailAccountStatusSchema })
  .openapi('RemoveEmailAccountResponse');

export type EmailAccountStatus = z.infer<typeof EmailAccountStatusSchema>;
export type SaveEmailAccountRequest = z.infer<typeof SaveEmailAccountRequestSchema>;
