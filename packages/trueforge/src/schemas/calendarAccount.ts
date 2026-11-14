import { z } from '@hono/zod-openapi';
import { ConnectorAccountStateSchema } from './connectorAccount';

export const CalendarProviderSchema = z
  .object({
    key: z.string().describe('Stable provider key, such as google or other.'),
    name: z.string().describe('The name the person sees in the provider picker.'),
    server_url: z
      .string()
      .nullable()
      .describe(
        'The built-in calendar address; null when it depends on the email domain, the email address or is typed.',
      ),
    account_url_template: z
      .string()
      .nullable()
      .describe('A built-in calendar address made from the email address; null when the provider does not use one.'),
    help_url: z
      .string()
      .nullable()
      .describe("The provider's own help page for making an app password; null when none could be checked."),
    help_hint: z.string().describe('One plain sentence on how to get an app password.'),
    setup_steps: z.array(z.string()).describe('Plain steps to show before the form; empty when the hint is enough.'),
  })
  .openapi('CalendarProvider');

export const CalendarAccountEntrySchema = z
  .object({
    email: z.string().describe('The email address of this account.'),
    username: z.string().describe('The login name of this account; never the password.'),
    calendar_url: z.string().describe('The calendar address of this account.'),
    provider_key: z.string().describe('The provider of this account, worked out from its address.'),
    state: ConnectorAccountStateSchema,
    is_default: z.boolean().describe('Whether this is the account new events land on.'),
  })
  .openapi('CalendarAccountEntry');

export const CalendarAccountStatusSchema = z
  .object({
    available: z
      .boolean()
      .describe('Whether this instance has the Calendar connector at all; when false, no card is shown.'),
    state: ConnectorAccountStateSchema,
    email: z.string().nullable().describe('The email address of the default account; null when none is connected.'),
    username: z.string().nullable().describe('The login name of the default account; never the password.'),
    calendar_url: z.string().nullable().describe('The calendar address of the default account; null when none.'),
    provider_key: z
      .string()
      .describe('The provider of the default account, worked out from its address; the picker default otherwise.'),
    accounts: z.array(CalendarAccountEntrySchema).describe('Every connected account, in saved order.'),
    default_address: z.string().nullable().describe('The account new events land on; null when none is connected.'),
    providers: z.array(CalendarProviderSchema).describe('The provider picker table, in display order.'),
  })
  .openapi('CalendarAccountStatus');

export const GetCalendarAccountResponseSchema = z
  .object({ data: CalendarAccountStatusSchema })
  .openapi('GetCalendarAccountResponse');

export const SaveCalendarAccountRequestSchema = z
  .object({
    provider_key: z.string().describe('The picked provider key, or other for a typed calendar address.'),
    email: z.string().describe('The email address of the calendar account.'),
    password: z
      .string()
      .describe('The app password. Write-only: it is checked and passed to the sidecar, never stored or returned.'),
    username: z.string().optional().describe('The login name, when it is not the email address.'),
    calendar_url: z.string().optional().describe('The https calendar address, only for the other provider.'),
  })
  .openapi('SaveCalendarAccountRequest');

export const SaveCalendarAccountResponseSchema = z
  .object({ data: CalendarAccountStatusSchema })
  .openapi('SaveCalendarAccountResponse');

export const RemoveCalendarAccountRequestSchema = z
  .object({
    address: z
      .string()
      .optional()
      .describe('The one account to remove, by its email address; without it, every connected account is removed.'),
  })
  .openapi('RemoveCalendarAccountRequest');

export const RemoveCalendarAccountResponseSchema = z
  .object({ data: CalendarAccountStatusSchema })
  .openapi('RemoveCalendarAccountResponse');

export const SetDefaultCalendarAccountRequestSchema = z
  .object({
    address: z.string().describe('The connected account to make the default, by its email address.'),
  })
  .openapi('SetDefaultCalendarAccountRequest');

export const SetDefaultCalendarAccountResponseSchema = z
  .object({ data: CalendarAccountStatusSchema })
  .openapi('SetDefaultCalendarAccountResponse');

export type CalendarAccountStatus = z.infer<typeof CalendarAccountStatusSchema>;
export type SaveCalendarAccountRequest = z.infer<typeof SaveCalendarAccountRequestSchema>;
export type RemoveCalendarAccountRequest = z.infer<typeof RemoveCalendarAccountRequestSchema>;
export type SetDefaultCalendarAccountRequest = z.infer<typeof SetDefaultCalendarAccountRequestSchema>;
