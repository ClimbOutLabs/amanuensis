/**
 * The API services Aman knows, each declaring for itself the hosts it answers on and what a
 * connection to those hosts can do. A service carries its own facts: a new service states its
 * hosts and its capability in its own entry here, and readers take the facts from the entry.
 * Nothing downstream keeps a list of host names of its own or guesses from a name.
 */

export interface ApiServiceDeclaration {
  /** The service's name, as the person would say it. */
  service: string;
  /** The API hosts this service answers on. */
  hosts: readonly string[];
  /** Hosts that carry a region or account in their name, matched whole. */
  host_patterns: readonly RegExp[];
  /**
   * True when a connection to these hosts can send mail or change a calendar, not only read.
   * A skill is never allowed to reach such a host: email goes out only through Aman, which asks
   * about each one.
   */
  can_send: boolean;
}

/** Google's mail and calendar APIs: a login that can read mail here can also send it, and the calendar API changes calendars. */
export const GOOGLE_API_SERVICE: ApiServiceDeclaration = {
  service: 'Google',
  hosts: ['gmail.googleapis.com', 'www.googleapis.com', 'mail.google.com'],
  host_patterns: [],
  can_send: true,
};

/** Microsoft's mail and calendar APIs: the Graph and Outlook hosts send mail and change calendars, not only read. */
export const MICROSOFT_API_SERVICE: ApiServiceDeclaration = {
  service: 'Microsoft',
  hosts: ['graph.microsoft.com', 'outlook.office365.com', 'outlook.office.com', 'outlook.live.com'],
  host_patterns: [],
  can_send: true,
};

/** Services whose whole job is sending email for whoever holds an account key. */
export const EMAIL_SENDING_SERVICES: readonly ApiServiceDeclaration[] = [
  { service: 'SendGrid', hosts: ['api.sendgrid.com'], host_patterns: [], can_send: true },
  { service: 'Mailgun', hosts: ['api.mailgun.net', 'api.eu.mailgun.net'], host_patterns: [], can_send: true },
  { service: 'Postmark', hosts: ['api.postmarkapp.com'], host_patterns: [], can_send: true },
  { service: 'Resend', hosts: ['api.resend.com'], host_patterns: [], can_send: true },
  {
    service: 'Amazon email',
    hosts: [],
    host_patterns: [/^(email|email-smtp|sesv2)\.[a-z0-9-]+\.amazonaws\.com$/],
    can_send: true,
  },
  { service: 'Brevo', hosts: ['api.brevo.com', 'api.sendinblue.com'], host_patterns: [], can_send: true },
  { service: 'Mailjet', hosts: ['api.mailjet.com'], host_patterns: [], can_send: true },
  { service: 'Mailchimp email', hosts: ['mandrillapp.com'], host_patterns: [], can_send: true },
  { service: 'SparkPost', hosts: ['api.sparkpost.com', 'api.eu.sparkpost.com'], host_patterns: [], can_send: true },
  { service: 'Mailtrap', hosts: ['send.api.mailtrap.io'], host_patterns: [], can_send: true },
  { service: 'SMTP2GO', hosts: ['api.smtp2go.com'], host_patterns: [], can_send: true },
  { service: 'Zoho Mail', hosts: [], host_patterns: [/^mail\.zoho\.[a-z.]+$/], can_send: true },
  { service: 'Fastmail', hosts: ['api.fastmail.com'], host_patterns: [], can_send: true },
  { service: 'Yahoo Mail', hosts: ['mail.yahoo.com'], host_patterns: [], can_send: true },
];

/** Services that turn a web request into an action of the account owner's choosing, such as an email. */
export const FORWARDING_SERVICES: readonly ApiServiceDeclaration[] = [
  { service: 'Zapier', hosts: ['hooks.zapier.com'], host_patterns: [], can_send: true },
  { service: 'IFTTT', hosts: ['maker.ifttt.com'], host_patterns: [], can_send: true },
  { service: 'Make', hosts: ['hook.integromat.com'], host_patterns: [/^hook\.[a-z0-9-]+\.make\.com$/], can_send: true },
  { service: 'Pipedream', hosts: [], host_patterns: [/^[a-z0-9-]+\.m\.pipedream\.net$/], can_send: true },
  { service: 'n8n', hosts: [], host_patterns: [/^[a-z0-9-]+\.app\.n8n\.cloud$/], can_send: true },
];

/** Every API service Aman knows, each with its own declaration. */
export const API_SERVICE_DECLARATIONS: readonly ApiServiceDeclaration[] = [
  GOOGLE_API_SERVICE,
  MICROSOFT_API_SERVICE,
  ...EMAIL_SENDING_SERVICES,
  ...FORWARDING_SERVICES,
];

/** The declaration of the service that owns this host, or undefined when no service declares it. */
export function apiServiceDeclarationForHost(input: {
  host: string;
  declarations: readonly ApiServiceDeclaration[];
}): ApiServiceDeclaration | undefined {
  const host = input.host.toLowerCase().replace(/\.$/, '');
  return input.declarations.find(
    declaration => declaration.hosts.includes(host) || declaration.host_patterns.some(pattern => pattern.test(host)),
  );
}

/**
 * True when any of the given hosts belongs to a service that declares it can send. A host no
 * service declares carries no such fact, so it counts as read-only reach.
 */
export function apiServiceHostsCanSend(input: {
  hosts: readonly string[];
  declarations: readonly ApiServiceDeclaration[];
}): boolean {
  return input.hosts.some(
    host => apiServiceDeclarationForHost({ host, declarations: input.declarations })?.can_send === true,
  );
}

/**
 * True when a skill may never reach this site, whatever was approved: a service that can send
 * email or change a calendar. Email goes out only through Aman, which asks about each one, and the
 * gateway cannot see inside the encrypted connection to tell a read from a send.
 */
export function isSkillBlockedHost(host: string): boolean {
  return apiServiceHostsCanSend({ hosts: [host], declarations: API_SERVICE_DECLARATIONS });
}
