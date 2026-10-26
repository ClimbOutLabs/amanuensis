import { z } from '@hono/zod-openapi';

export const CalendarProviderSchema = z
  .object({
    key: z.string().describe('Stable provider key, such as fastmail or other.'),
    name: z.string().describe('The name the person sees in the provider picker.'),
    server_url: z
      .string()
      .nullable()
      .describe('The built-in calendar address; null when it depends on the email domain or is typed.'),
    help_url: z
      .string()
      .nullable()
      .describe("The provider's own help page for making an app password; null when none could be checked."),
    help_hint: z.string().describe('One plain sentence on how to get an app password.'),
  })
  .openapi('CalendarProvider');

export const CalendarAccountStatusSchema = z
  .object({
    available: z
      .boolean()
      .describe('Whether this instance has the Calendar connector at all; when false, no card is shown.'),
    state: z
      .enum(['connected', 'not_connected', 'sign_in_stopped'])
      .describe('Connected, not connected, or connected but the saved sign-in no longer works.'),
    email: z.string().nullable().describe('The email address of the connected account; null when none is connected.'),
    provider_key: z
      .string()
      .describe('The provider of the connected account, worked out from its address; the picker default otherwise.'),
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

export const RemoveCalendarAccountResponseSchema = z
  .object({ data: CalendarAccountStatusSchema })
  .openapi('RemoveCalendarAccountResponse');

export type CalendarAccountStatus = z.infer<typeof CalendarAccountStatusSchema>;
export type SaveCalendarAccountRequest = z.infer<typeof SaveCalendarAccountRequestSchema>;
