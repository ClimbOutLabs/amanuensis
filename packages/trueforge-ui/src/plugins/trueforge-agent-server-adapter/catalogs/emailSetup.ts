/**
 * Maps the email account port onto the server's settings email routes with plain fetch.
 * The routes are browser-session only, like the chat images routes: they accept the browser
 * session cookie and refuse any bearer token, so no Authorization header is sent even when
 * the client has one. Bodies are parsed defensively; an unrecognized shape is dropped.
 */
import { z } from 'zod';
import type { EmailAccountSaveRequest, EmailAccountStatus, EmailSetupPort } from '../../../server/emailSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

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

/** The server's plain failure line, when the body carries one; the server only sends fixed lines. */
function serverErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error = new Map(Object.entries(body)).get('error');
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const message = new Map(Object.entries(error)).get('message');
  return typeof message === 'string' && message !== '' ? message : undefined;
}

export function createEmailSetupApi(options: CreateTrueForgeClientOptions = {}): EmailSetupPort {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const url = `${base}/api/v1/user/settings/email`;

  async function request(input: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<EmailAccountStatus> {
    const response = await fetchImpl(input.method === 'GET' ? `${url}/status` : url, {
      method: input.method,
      credentials: 'same-origin',
      headers: input.method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      ...(input.method === 'GET' ? {} : { body: JSON.stringify(input.body ?? {}) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(serverErrorMessage(body) ?? `Email request failed with HTTP ${String(response.status)}`);
    }
    const parsed = z.object({ data: EmailAccountStatusWireSchema }).safeParse(body);
    if (!parsed.success) {
      throw new Error('The server returned an unexpected email payload');
    }
    return toEmailStatus(parsed.data.data);
  }

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
