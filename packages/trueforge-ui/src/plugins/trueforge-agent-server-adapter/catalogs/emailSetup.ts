/**
 * Maps the email account port onto the server's settings email routes (see accountSetupRequest.ts for
 * how the calls are made). The routes are browser-session only: they accept the browser session
 * cookie and refuse any bearer token.
 */
import { z } from 'zod';
import type { EmailAccountSaveRequest, EmailAccountStatus, EmailSetupPort } from '../../../server/emailSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';
import { createAccountSetupRequest } from './accountSetupRequest.js';

const EmailProviderWireSchema = z.object({
  key: z.string(),
  name: z.string(),
  imap_host: z.string(),
  imap_port: z.number(),
  imap_mode: z.enum(['ssl', 'starttls']),
  smtp_host: z.string(),
  smtp_port: z.number(),
  smtp_mode: z.enum(['ssl', 'starttls']),
  help_url: z.string().nullable(),
  help_hint: z.string(),
});

const EmailAccountStatusWireSchema = z.object({
  available: z.boolean(),
  state: z.enum(['connected', 'not_connected', 'sign_in_stopped']),
  address: z.string().nullable(),
  provider_key: z.string(),
  providers: z.array(EmailProviderWireSchema),
});

type EmailAccountStatusWire = z.infer<typeof EmailAccountStatusWireSchema>;

function toEmailStatus(wire: EmailAccountStatusWire): EmailAccountStatus {
  return {
    available: wire.available,
    state: wire.state,
    address: wire.address,
    providerKey: wire.provider_key,
    providers: wire.providers.map(provider => ({
      key: provider.key,
      name: provider.name,
      imapHost: provider.imap_host,
      imapPort: provider.imap_port,
      imapMode: provider.imap_mode,
      smtpHost: provider.smtp_host,
      smtpPort: provider.smtp_port,
      smtpMode: provider.smtp_mode,
      helpUrl: provider.help_url,
      helpHint: provider.help_hint,
    })),
  };
}

export function createEmailSetupApi(options: CreateTrueForgeClientOptions = {}): EmailSetupPort {
  const request = createAccountSetupRequest({
    options,
    path: '/api/v1/user/settings/email',
    label: 'Email',
    wireSchema: EmailAccountStatusWireSchema,
    toStatus: toEmailStatus,
  });

  return {
    getEmailStatus: async () => request({ method: 'GET' }),
    saveEmailAccount: async (req: EmailAccountSaveRequest) =>
      request({
        method: 'POST',
        body: {
          provider_key: req.providerKey,
          address: req.address,
          password: req.password,
          ...(req.imapHost === undefined ? {} : { imap_host: req.imapHost }),
          ...(req.imapPort === undefined ? {} : { imap_port: req.imapPort }),
          ...(req.smtpHost === undefined ? {} : { smtp_host: req.smtpHost }),
          ...(req.smtpPort === undefined ? {} : { smtp_port: req.smtpPort }),
        },
      }),
    // A JSON body is sent on purpose: a bodiless state-changing call can be refused as
    // not-from-Aman when the instance is reached through its proxy address.
    removeEmailAccount: async () => request({ method: 'DELETE', body: {} }),
  };
}
