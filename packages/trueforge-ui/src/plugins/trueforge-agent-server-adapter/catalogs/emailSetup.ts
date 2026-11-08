/**
 * Maps the email account port onto the server's settings email routes (see accountSetupRequest.ts for
 * how the calls are made). The routes are browser-session only: they accept the browser session
 * cookie and refuse any bearer token.
 */
import { z } from 'zod';
import type { EmailAccountSaveRequest, EmailAccountStatus, EmailSetupPort } from '../../../server/emailSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';
import { AccountConnectionStateWireSchema, createAccountSetupRequest } from './accountSetupRequest.js';

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

const EmailAccountEntryWireSchema = z.object({
  address: z.string(),
  provider_key: z.string(),
  state: AccountConnectionStateWireSchema,
  is_default: z.boolean(),
  imap_host: z.string(),
  imap_port: z.number(),
  imap_mode: z.enum(['ssl', 'starttls']),
  smtp_host: z.string(),
  smtp_port: z.number(),
  smtp_mode: z.enum(['ssl', 'starttls']),
});

const EmailAccountStatusWireSchema = z.object({
  available: z.boolean(),
  state: AccountConnectionStateWireSchema,
  address: z.string().nullable(),
  provider_key: z.string(),
  accounts: z.array(EmailAccountEntryWireSchema),
  default_address: z.string().nullable(),
  providers: z.array(EmailProviderWireSchema),
});

type EmailAccountStatusWire = z.infer<typeof EmailAccountStatusWireSchema>;

function toEmailStatus(wire: EmailAccountStatusWire): EmailAccountStatus {
  return {
    available: wire.available,
    state: wire.state,
    address: wire.address,
    providerKey: wire.provider_key,
    accounts: wire.accounts.map(account => ({
      address: account.address,
      providerKey: account.provider_key,
      state: account.state,
      isDefault: account.is_default,
      imapHost: account.imap_host,
      imapPort: account.imap_port,
      imapMode: account.imap_mode,
      smtpHost: account.smtp_host,
      smtpPort: account.smtp_port,
      smtpMode: account.smtp_mode,
    })),
    defaultAddress: wire.default_address,
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
    removeEmailAccount: async (address?: string) =>
      request({ method: 'DELETE', body: address === undefined ? {} : { address } }),
    setDefaultEmailAccount: async (address: string) =>
      request({ method: 'POST', suffix: '/default', body: { address } }),
  };
}
