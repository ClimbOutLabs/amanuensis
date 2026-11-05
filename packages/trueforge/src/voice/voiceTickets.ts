/**
 * One-time tickets for opening a voice connection. A browser WebSocket cannot send its own headers,
 * so the person first asks for a ticket over the normal, signed-in, same-origin request, which is
 * where the app's sign-in and cross-site checks happen. The ticket is then shown once when the
 * socket opens. It is short-lived and good for one connection.
 */
import { randomBytes } from 'node:crypto';

const TICKET_TTL_MS = 30_000;
const MAX_OPEN_TICKETS = 1_000;

export interface VoiceTicket {
  tenantId: string;
  subjectId: string;
  sessionId: string;
  /** The headers of the request that asked, so the chat's own turn route sees the same person. */
  headers: Record<string, string>;
  timezone: string | undefined;
  voice: string | undefined;
}

export class VoiceTicketStore {
  readonly #open = new Map<string, { ticket: VoiceTicket; expiresAtMs: number }>();
  readonly #now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now;
  }

  issue(ticket: VoiceTicket): { id: string; expiresInSeconds: number } {
    const now = this.#now();
    for (const [id, entry] of this.#open) {
      if (entry.expiresAtMs <= now) {
        this.#open.delete(id);
      }
    }
    if (this.#open.size >= MAX_OPEN_TICKETS) {
      const oldest = this.#open.keys().next();
      if (!oldest.done) {
        this.#open.delete(oldest.value);
      }
    }
    const id = randomBytes(24).toString('base64url');
    this.#open.set(id, { ticket, expiresAtMs: now + TICKET_TTL_MS });
    return { id, expiresInSeconds: TICKET_TTL_MS / 1000 };
  }

  /** Single use: a ticket that was redeemed, or has expired, or never existed, gives nothing. */
  redeem(id: string): VoiceTicket | undefined {
    const entry = this.#open.get(id);
    this.#open.delete(id);
    return entry !== undefined && entry.expiresAtMs > this.#now() ? entry.ticket : undefined;
  }
}

/** The one store this process shares between the route that issues tickets and the socket that redeems them. */
export const voiceTickets = new VoiceTicketStore();
