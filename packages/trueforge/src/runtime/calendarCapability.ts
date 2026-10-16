/**
 * Google Calendar for one user's turn: the read tools, mounted only when that user has a working Google login
 * that granted calendar access. Without one nothing mounts, and the chat simply has no calendar tools.
 */
import type { AgentCapability, AgentTracing, SentinelHostContext } from '@truefoundry/trueforge-core/core';
import { CalendarApi } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import { CalendarToolSet } from '@truefoundry/trueforge-core/core/calendar/CalendarToolSet';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';

interface CalendarCapabilityOptions {
  connections: GoogleConnectionStore;
  owner: GoogleOwner;
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
  /** The user's IANA time zone from their device, when the turn carried one. */
  timeZone: string | undefined;
  /** Replaceable so tests never reach Google. */
  fetchImpl: typeof fetch | undefined;
}

export async function calendarCapability(options: CalendarCapabilityOptions): Promise<AgentCapability | undefined> {
  const record = await options.connections.get(options.owner);
  if (record?.status !== 'connected') {
    return undefined;
  }
  const features = grantedFeatures(record.granted_scopes);
  if (!features.includes('calendar_read')) {
    return undefined;
  }
  const tokens = new GoogleAccessTokens({
    now: undefined,
    connections: options.connections,
    owner: options.owner,
    fetchImpl: options.fetchImpl,
  });
  return {
    systemToolSets: [
      new CalendarToolSet({
        tracing: options.tracing,
        api: new CalendarApi({ sleep: undefined, tokens, fetchImpl: options.fetchImpl }),
        account: record.account_email ?? 'your Google account',
        features,
        timeZone: options.timeZone,
        sentinel: options.sentinel,
      }),
    ],
  };
}
