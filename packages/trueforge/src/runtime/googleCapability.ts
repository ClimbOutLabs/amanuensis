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
import { CalendarApi, type CalendarApiPort } from '@truefoundry/trueforge-core/core/calendar/CalendarApi';
import { CalendarToolSet } from '@truefoundry/trueforge-core/core/calendar/CalendarToolSet';
import { GmailApi, LIST_DEADLINE_MS, type GmailApiPort } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import { GmailToolSet, type AttachmentStager } from '@truefoundry/trueforge-core/core/email/gmail/GmailToolSet';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { grantedFeatures, type GoogleFeature } from '@truefoundry/trueforge-core/core/google/scopes';
import type { Logger } from 'winston';

import type { EvalSources } from '../eval/fixtures';
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
  /** The user's stored Google login. Absent only in eval mode, where the fixtures answer instead. */
  connections: GoogleConnectionStore | undefined;
  /** Set in eval mode: mail and calendar come from the fixtures and no login is read or used. */
  evalSources: EvalSources | undefined;
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

/** What the Gmail and Calendar tools are built on: the grants, the account name, and the two API sources. */
interface GoogleSource {
  features: GoogleFeature[];
  account: string;
  gmail: GmailApiPort;
  calendar: CalendarApiPort;
}

/** Every feature is granted in eval mode so the fixture tools mount the same way a fully connected login would. */
const EVAL_FEATURES: GoogleFeature[] = ['gmail_read', 'gmail_compose', 'calendar_read', 'calendar_write'];

async function liveSource(
  options: GoogleCapabilityOptions & { connections: GoogleConnectionStore },
): Promise<GoogleSource | undefined> {
  const record = await options.connections.get(options.owner);
  if (record?.status !== 'connected') {
    return undefined;
  }
  const features = grantedFeatures(record.granted_scopes);
  if (!features.includes('gmail_read') && !features.includes('calendar_read')) {
    return undefined;
  }
  const tokens = new GoogleAccessTokens({
    now: undefined,
    connections: options.connections,
    owner: options.owner,
    fetchImpl: options.fetchImpl,
  });
  return {
    features,
    account: record.account_email ?? 'your Google account',
    gmail: new GmailApi({ sleep: undefined, tokens, fetchImpl: options.fetchImpl }),
    calendar: new CalendarApi({ sleep: undefined, tokens, fetchImpl: options.fetchImpl }),
  };
}

export async function googleCapability(options: GoogleCapabilityOptions): Promise<AgentCapability | undefined> {
  let source: GoogleSource | undefined;
  if (options.evalSources !== undefined) {
    source = {
      features: EVAL_FEATURES,
      account: options.evalSources.mailOwner,
      gmail: options.evalSources.gmail,
      calendar: options.evalSources.calendar,
    };
  } else if (options.connections !== undefined) {
    source = await liveSource({ ...options, connections: options.connections });
  }
  if (source === undefined) {
    return undefined;
  }
  const { features, account } = source;
  const hasMail = features.includes('gmail_read');
  const hasCalendar = features.includes('calendar_read');
  if (!hasMail && !hasCalendar) {
    return undefined;
  }
  return {
    systemToolSets: [
      ...(hasMail
        ? [
            new GmailToolSet({
              tracing: options.tracing,
              api: source.gmail,
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
              api: source.calendar,
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
