'use client';

import type { ScheduleToolsCatalog } from '../../plugins/trueforge-agent-server-adapter/catalogs/scheduleToolsCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/**
 * The trueforge adapter attaches a `scheduleTools` port next to the runtime's `AgentUIServer` surface; other
 * servers don't carry it, and the form then leaves the Tools section out.
 */
function hasScheduleToolsPort(server: object): server is { scheduleTools: ScheduleToolsCatalog } {
  const port: unknown = Reflect.get(server, 'scheduleTools');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getScheduleTools') === 'function' &&
    typeof Reflect.get(port, 'setScheduleTools') === 'function'
  );
}

export function useScheduleToolsPort(): ScheduleToolsCatalog | null {
  const server = useOptionalServer();
  return server !== null && hasScheduleToolsPort(server) ? server.scheduleTools : null;
}
