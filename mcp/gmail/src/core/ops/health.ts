// health_check op — the canary tool. Never touches Gmail; answers
// instantly so health is reachable even when the network is down.

import { formatHealthText, readWatchdogState, snapshotHealth } from "@george43g/robustness";
import type { z } from "zod";
import { HealthCheckOutputSchema, HealthCheckSchema } from "../../tools.js";
import { type Operation, registry } from "../registry.js";
import { getRecentErrorCount, getToolCallCount } from "../session.js";

type HealthOutput = z.infer<typeof HealthCheckOutputSchema>;

const op: Operation<unknown, HealthOutput> = {
  name: "health_check",
  schema: HealthCheckSchema,
  outputSchema: HealthCheckOutputSchema,
  scopes: [],
  handler: async (_input, _ctx) => {
    const snap = snapshotHealth(
      {
        toolCalls: getToolCallCount(),
        recentErrors: getRecentErrorCount(),
      },
      readWatchdogState(),
    );
    return {
      content: [{ type: "text", text: formatHealthText(snap) }],
      structuredContent: snap,
    };
  },
};

registry.register(op);
