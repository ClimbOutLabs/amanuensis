/**
 * Google for one user's turn: the Gmail and Calendar tools, mounted only when that user has a working Google
 * login that granted them. The login is read once and shares one token cache, so a turn using mail and calendar
 * refreshes the OAuth token once. Without a login nothing mounts, and the chat simply has no Google tools.
 */
import {
  stageAttachment,
  type AgentCapability,
  type AgentTracing,
  type Sandbox,
  type SentinelHostContext,
} from '@truefoundry/trueforge-core/core';
import { CalendarApi } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import { CalendarToolSet } from '@truefoundry/trueforge-core/core/calendar/CalendarToolSet';
import { GmailApi, LIST_DEADLINE_MS } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import { GmailToolSet, type AttachmentStager } from '@truefoundry/trueforge-core/core/email/gmail/GmailToolSet';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';
import type { Logger } from 'winston';
/** Puts a mail attachment in the turn's sandbox through the one staging helper; no sandbox, no stager. */
export function sandboxAttachmentStager(
  sandbox: Pick<Sandbox, 'uploadUserFile'> | undefined,
): AttachmentStager | undefined {
  if (sandbox === undefined) {
    return undefined;
  }
  return {
    stageAttachment: async input => {
      const staged = await stageAttachment({ sandbox, ...input });
      return { filename: staged.filename, path: staged.path, sandboxCreated: staged.sandboxCreated };
    },
  };
}

interface GoogleCapabilityOptions {
  connections: GoogleConnectionStore;
  owner: GoogleOwner;
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
  /** Absent when the turn has no sandbox: attachment fetch is then not offered and mail results say why. */
  attachmentStager: AttachmentStager | undefined;
  /** The user's IANA time zone from their device, when the turn carried one. */
  timeZone: string | undefined;
  /** Replaceable so tests never reach Google. */
  fetchImpl: typeof fetch | undefined;
  logger: Logger;
}

export async function googleCapability(options: GoogleCapabilityOptions): Promise<AgentCapability | undefined> {
  const record = await options.connections.get(options.owner);
  if (record?.status !== 'connected') {
    return undefined;
  }
  const features = grantedFeatures(record.granted_scopes);
  const hasMail = features.includes('gmail_read');
  const hasCalendar = features.includes('calendar_read');
  if (!hasMail && !hasCalendar) {
    return undefined;
  }
  const tokens = new GoogleAccessTokens({
    now: undefined,
    connections: options.connections,
    owner: options.owner,
    fetchImpl: options.fetchImpl,
  });
  const account = record.account_email ?? 'your Google account';
  return {
    systemToolSets: [
      ...(hasMail
        ? [
            new GmailToolSet({
              tracing: options.tracing,
              api: new GmailApi({ sleep: undefined, tokens, fetchImpl: options.fetchImpl }),
              account,
              features,
              attachmentStager: options.attachmentStager,
              sentinel: options.sentinel,
              listDeadlineMs: LIST_DEADLINE_MS,
            }),
          ]
        : []),
      ...(hasCalendar
        ? [
            new CalendarToolSet({
              tracing: options.tracing,
              api: new CalendarApi({ sleep: undefined, tokens, fetchImpl: options.fetchImpl }),
              account,
              features,
              timeZone: options.timeZone,
              sentinel: options.sentinel,
              logger: options.logger,
            }),
          ]
        : []),
    ],
  };
}
