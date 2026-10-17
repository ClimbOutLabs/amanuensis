/**
 * Gmail for one user's turn: the read tools, mounted only when that user has a working Google login that
 * granted mail access. Without one nothing mounts, and the chat simply has no mail tools.
 */
import {
  stageAttachment,
  type AgentCapability,
  type AgentTracing,
  type Sandbox,
  type SentinelHostContext,
} from '@truefoundry/trueforge-core/core';
import { GmailApi, LIST_DEADLINE_MS } from '@truefoundry/trueforge-core/core/email/gmail/gmailApi';
import { GmailToolSet, type AttachmentStager } from '@truefoundry/trueforge-core/core/email/gmail/GmailToolSet';
import type { GoogleConnectionStore, GoogleOwner } from '@truefoundry/trueforge-core/core/google/connection';
import { GoogleAccessTokens } from '@truefoundry/trueforge-core/core/google/GoogleAccessTokens';
import { grantedFeatures } from '@truefoundry/trueforge-core/core/google/scopes';

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

interface GmailCapabilityOptions {
  connections: GoogleConnectionStore;
  owner: GoogleOwner;
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
  /** Absent when the turn has no sandbox: attachment fetch is then not offered and mail results say why. */
  attachmentStager: AttachmentStager | undefined;
  /** Replaceable so tests never reach Google. */
  fetchImpl: typeof fetch | undefined;
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
    now: undefined,
    connections: options.connections,
    owner: options.owner,
    fetchImpl: options.fetchImpl,
  });
  return {
    systemToolSets: [
      new GmailToolSet({
        tracing: options.tracing,
        api: new GmailApi({ sleep: undefined, tokens, fetchImpl: options.fetchImpl }),
        account: record.account_email ?? 'your Google account',
        features,
        attachmentStager: options.attachmentStager,
        sentinel: options.sentinel,
        listDeadlineMs: LIST_DEADLINE_MS,
      }),
    ],
  };
}
