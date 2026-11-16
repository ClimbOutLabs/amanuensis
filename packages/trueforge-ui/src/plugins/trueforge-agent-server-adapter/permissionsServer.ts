import { createTrueForgeClient, type CreateTrueForgeClientOptions } from '@truefoundry/trueforge-chat';
import type { TrueForge } from '@truefoundry/trueforge-sdk';

import type { PermissionsServer } from '../../server/types.js';

export type CreateHarnessPermissionsServerOptions = CreateTrueForgeClientOptions & {
  client?: TrueForge;
};

export function createHarnessPermissionsServer(options: CreateHarnessPermissionsServerOptions = {}): PermissionsServer {
  const client = options.client ?? createTrueForgeClient(options);
  return {
    listPermissions: request => client.internal.listPermissions(request),
  };
}
