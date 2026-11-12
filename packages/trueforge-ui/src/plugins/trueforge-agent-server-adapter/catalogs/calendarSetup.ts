/**
 * Maps the calendar account port onto the server's settings calendar routes (see
 * accountSetupRequest.ts for how the calls are made). The routes are browser-session only: they
 * accept the browser session cookie and refuse any bearer token.
 */
import { z } from 'zod';
import type {
  CalendarAccountSaveRequest,
  CalendarAccountStatus,
  CalendarSetupPort,
} from '../../../server/calendarSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';
import { AccountConnectionStateWireSchema, createAccountSetupRequest } from './accountSetupRequest.js';

const CalendarProviderWireSchema = z.object({
  key: z.string(),
  name: z.string(),
  server_url: z.string().nullable(),
  account_url_template: z.string().nullable(),
  help_url: z.string().nullable(),
  help_hint: z.string(),
  setup_steps: z.array(z.string()),
});

const CalendarAccountStatusWireSchema = z.object({
  available: z.boolean(),
  state: AccountConnectionStateWireSchema,
  email: z.string().nullable(),
  username: z.string().nullable(),
  calendar_url: z.string().nullable(),
  provider_key: z.string(),
  providers: z.array(CalendarProviderWireSchema),
});

type CalendarAccountStatusWire = z.infer<typeof CalendarAccountStatusWireSchema>;

function toCalendarStatus(wire: CalendarAccountStatusWire): CalendarAccountStatus {
  return {
    available: wire.available,
    state: wire.state,
    email: wire.email,
    username: wire.username,
    calendarUrl: wire.calendar_url,
    providerKey: wire.provider_key,
    providers: wire.providers.map(provider => ({
      key: provider.key,
      name: provider.name,
      serverUrl: provider.server_url,
      accountUrlTemplate: provider.account_url_template,
      helpUrl: provider.help_url,
      helpHint: provider.help_hint,
      setupSteps: provider.setup_steps,
    })),
  };
}

export function createCalendarSetupApi(options: CreateTrueForgeClientOptions = {}): CalendarSetupPort {
  const request = createAccountSetupRequest({
    options,
    path: '/api/v1/user/settings/calendar',
    wireSchema: CalendarAccountStatusWireSchema,
    toStatus: toCalendarStatus,
  });

  return {
    getCalendarStatus: async () => request({ method: 'GET' }),
    saveCalendarAccount: async (req: CalendarAccountSaveRequest) =>
      request({
        method: 'POST',
        body: {
          provider_key: req.providerKey,
          email: req.email,
          password: req.password,
          ...(req.username === undefined ? {} : { username: req.username }),
          ...(req.calendarUrl === undefined ? {} : { calendar_url: req.calendarUrl }),
        },
      }),
    // A JSON body is sent on purpose: a bodiless state-changing call can be refused as
    // not-from-this-app when the instance is reached through its proxy address.
    removeCalendarAccount: async () => request({ method: 'DELETE', body: {} }),
  };
}
