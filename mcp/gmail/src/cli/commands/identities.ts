// `gmail identities` — lists send-as identities, forwarding addresses, and
// inbound routing filters (the list_send_identities tool). Read-only; helps
// see catch-all / forwarding setups and which identity to send/reply as.

import { Command } from "commander";
import { runCliOp } from "../runtime.js";

export function buildIdentitiesCommand(): Command {
  const cmd = new Command("identities");
  cmd
    .description("List send-as identities, forwarding addresses, and routing filters")
    .option("--json", "Emit typed JSON")
    .action(async (options: { json?: boolean }) => {
      await runCliOp("list_send_identities", {}, options);
    });
  return cmd;
}
