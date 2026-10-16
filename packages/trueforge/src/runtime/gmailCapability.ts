/**
 * Gmail for one user's turn: the read tools, mounted only when that user has a working Google login that
 * granted mail access. Without one nothing mounts, and the chat simply has no mail tools.
 */
import type { AgentCapability, AgentTracing, SentinelHostContext } from '@truefoundry/trueforge-core/core';
import { GmailApi } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import { GmailToolSet, type AttachmentStager } from '@truefoundry/trueforge-core/core/email/gmail/GmailToolSet';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';

export interface GmailCapabilityOptions {
  connections: GoogleConnectionStore;
  owner: GoogleOwner;
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
  /** Absent until the server's `stageAttachment` helper is bound to the turn's sandbox; attachment fetch then says there is no workspace. */
  attachmentStager: AttachmentStager | undefined;
  /** Replaceable so tests never reach Google. */
  fetchImpl?: typeof fetch | undefined;
}

export async function gmailCapability(options: GmailCapabilityOptions): Promise<AgentCapability | undefined> {
  const record = await options.connections.get(options.owner);
  if (record?.status !== 'connected') {
    return undefined;
  }
  const features = grantedFeatures(record.granted_scopes);
  if (!features.includes('gmail_read')) {
    return undefined;
  }
  const tokens = new GoogleAccessTokens({
    connections: options.connections,
    owner: options.owner,
    fetchImpl: options.fetchImpl,
  });
  return {
    systemToolSets: [
      new GmailToolSet({
        tracing: options.tracing,
        api: new GmailApi({ tokens, fetchImpl: options.fetchImpl }),
        account: record.account_email ?? 'your Google account',
        features,
        attachmentStager: options.attachmentStager,
        sentinel: options.sentinel,
      }),
    ],
  };
}
