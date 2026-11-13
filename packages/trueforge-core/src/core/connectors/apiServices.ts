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
  /**
   * True when a connection to these hosts can send mail or change a calendar, not only read.
   * Reaching such a host with a service login can send too, and an approval that covers the
   * host has to say so.
   */
  can_send: boolean;
}

/** Google's mail and calendar APIs: a login that can read mail here can also send it, and the calendar API changes calendars. */
export const GOOGLE_API_SERVICE: ApiServiceDeclaration = {
  service: 'Google',
  hosts: ['gmail.googleapis.com', 'www.googleapis.com'],
  can_send: true,
};

/** Microsoft's mail and calendar APIs: the Graph and Outlook hosts send mail and change calendars, not only read. */
export const MICROSOFT_API_SERVICE: ApiServiceDeclaration = {
  service: 'Microsoft',
  hosts: ['graph.microsoft.com', 'outlook.office365.com'],
  can_send: true,
};

/** Every API service Aman knows, each with its own declaration. */
export const API_SERVICE_DECLARATIONS: readonly ApiServiceDeclaration[] = [GOOGLE_API_SERVICE, MICROSOFT_API_SERVICE];

/** The declaration of the service that owns this host, or undefined when no service declares it. */
export function apiServiceDeclarationForHost(input: {
  host: string;
  declarations: readonly ApiServiceDeclaration[];
}): ApiServiceDeclaration | undefined {
  return input.declarations.find(declaration => declaration.hosts.includes(input.host));
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
