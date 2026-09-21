import { apiOpts } from "./core/api.js";
/**
 * Send-as / forwarding settings reader for Gmail MCP Server.
 *
 * Thin wrappers over `gmail.users.settings.sendAs.*` and
 * `gmail.users.settings.forwardingAddresses.*`. Read-only; all reads fall
 * under the `gmail.settings.basic` scope (already a default scope). Style
 * matches src/filter-manager.ts — standalone async fns taking the gmail handle.
 */

// The subset of a Gmail "Send mail as" identity we surface.
export interface GmailSendAs {
  sendAsEmail: string;
  displayName?: string;
  replyToAddress?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
  treatAsAlias?: boolean;
  verificationStatus?: string;
}

export interface GmailForwardingAddress {
  forwardingEmail: string;
  verificationStatus?: string;
}

/**
 * Lists the account's configured "Send mail as" identities (the primary
 * address plus any verified aliases). These are the identities an agent may
 * send *as*, and the input to closest-identity reply-from selection.
 */
export async function listSendAs(gmail: any, signal?: AbortSignal): Promise<GmailSendAs[]> {
  try {
    const response = await gmail.users.settings.sendAs.list({ userId: "me" }, apiOpts({ signal }));
    const sendAs = response.data.sendAs || [];
    return sendAs.map(
      (s: any): GmailSendAs => ({
        sendAsEmail: s.sendAsEmail ?? "",
        displayName: s.displayName ?? undefined,
        replyToAddress: s.replyToAddress ?? undefined,
        isDefault: s.isDefault ?? undefined,
        isPrimary: s.isPrimary ?? undefined,
        treatAsAlias: s.treatAsAlias ?? undefined,
        verificationStatus: s.verificationStatus ?? undefined,
      }),
    );
  } catch (error: any) {
    throw new Error(`Failed to list send-as identities: ${error.message}`, { cause: error });
  }
}

/**
 * Lists the account's configured forwarding addresses (Gmail-side forwarding,
 * distinct from any upstream/provider forwarding). Useful for surfacing where
 * inbound mail may be routed.
 */
export async function listForwardingAddresses(gmail: any, signal?: AbortSignal): Promise<GmailForwardingAddress[]> {
  try {
    const response = await gmail.users.settings.forwardingAddresses.list({ userId: "me" }, apiOpts({ signal }));
    const addresses = response.data.forwardingAddresses || [];
    return addresses.map(
      (a: any): GmailForwardingAddress => ({
        forwardingEmail: a.forwardingEmail ?? "",
        verificationStatus: a.verificationStatus ?? undefined,
      }),
    );
  } catch (error: any) {
    throw new Error(`Failed to list forwarding addresses: ${error.message}`, { cause: error });
  }
}
