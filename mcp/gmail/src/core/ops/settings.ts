// Account-settings read op: list_send_identities.
//
// Surfaces the account's send-as identities, forwarding addresses, and the
// filters that route inbound mail — enough for an agent to understand a
// catch-all / forwarding setup ("mail to X@domain lands in label Y") and to
// choose the right identity to send as. Read-only; scope gmail.settings.basic.

import type { z } from "zod";
import { listFilters } from "../../filter-manager.js";
import { listForwardingAddresses, listSendAs } from "../../sendas-manager.js";
import { ListSendIdentitiesOutputSchema, ListSendIdentitiesSchema } from "../../tools.js";
import { listMeta } from "../email-helpers.js";
import { type Operation, registry } from "../registry.js";

type ListSendIdentitiesOutput = z.infer<typeof ListSendIdentitiesOutputSchema>;

const listSendIdentities: Operation<unknown, ListSendIdentitiesOutput> = {
  name: "list_send_identities",
  schema: ListSendIdentitiesSchema,
  outputSchema: ListSendIdentitiesOutputSchema,
  scopes: ["gmail.settings.basic"],
  handler: async (_input, ctx) => {
    const [sendAs, forwarding, filterResult] = await Promise.all([
      listSendAs(ctx.gmail, ctx.signal),
      listForwardingAddresses(ctx.gmail, ctx.signal),
      listFilters(ctx.gmail, ctx.signal),
    ]);

    const sendAsIdentities = sendAs.map((s) => ({
      email: s.sendAsEmail,
      displayName: s.displayName ?? null,
      isDefault: s.isDefault ?? false,
      isPrimary: s.isPrimary ?? false,
      treatAsAlias: s.treatAsAlias ?? false,
      verificationStatus: s.verificationStatus ?? null,
    }));

    const forwardingAddresses = forwarding.map((f) => ({
      email: f.forwardingEmail,
      verificationStatus: f.verificationStatus ?? null,
    }));

    // Keep filters that actually route inbound mail: a label/forward action, or
    // a `to:` criterion (the recipient pattern that reveals a catch-all).
    // biome-ignore lint/suspicious/noExplicitAny: raw Gmail filter shape
    const inboundRoutingFilters = (filterResult.filters as any[])
      .map((f) => ({
        id: String(f.id ?? ""),
        to: f.criteria?.to ?? null,
        from: f.criteria?.from ?? null,
        query: f.criteria?.query ?? null,
        addLabelIds: (f.action?.addLabelIds ?? []) as string[],
        removeLabelIds: (f.action?.removeLabelIds ?? []) as string[],
        forward: f.action?.forward ?? null,
      }))
      .filter((f) => f.to !== null || f.addLabelIds.length > 0 || f.forward !== null);

    const structured: ListSendIdentitiesOutput = {
      sendAsIdentities,
      forwardingAddresses,
      inboundRoutingFilters,
      // Settings are fully enumerated in one call each — never truncated.
      ...listMeta(sendAsIdentities.length),
    };

    const lines: string[] = [];
    lines.push(`Send-as identities (${sendAsIdentities.length}):`);
    for (const s of sendAsIdentities) {
      const tags = [
        s.isPrimary ? "primary" : null,
        s.isDefault ? "default" : null,
        s.treatAsAlias ? "alias" : null,
      ].filter(Boolean);
      lines.push(`  - ${s.email}${tags.length ? `  [${tags.join(", ")}]` : ""}`);
    }
    if (forwardingAddresses.length > 0) {
      lines.push("", `Forwarding addresses (${forwardingAddresses.length}):`);
      for (const f of forwardingAddresses) lines.push(`  - ${f.email} (${f.verificationStatus})`);
    }
    if (inboundRoutingFilters.length > 0) {
      lines.push("", `Inbound routing filters (${inboundRoutingFilters.length}):`);
      for (const f of inboundRoutingFilters) {
        const match = f.to ? `to:${f.to}` : f.from ? `from:${f.from}` : (f.query ?? "(query)");
        const action = f.addLabelIds.length
          ? `→ label ${f.addLabelIds.join(",")}`
          : f.forward
            ? `→ forward ${f.forward}`
            : "";
        lines.push(`  - ${match} ${action}`.trimEnd());
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: structured,
    };
  },
};

registry.register(listSendIdentities);
