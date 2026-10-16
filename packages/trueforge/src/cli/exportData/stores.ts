import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { IAgentStore } from '../../db/agentStore';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IMcpServerStore } from '../../db/mcpServerStore';
import type { IModelProviderStore } from '../../db/modelProviderStore';
import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IPersonaStore } from '../../db/personaStore';
import type { ISandboxProviderStore } from '../../db/sandboxProviderStore';
import type { IScheduleStore } from '../../db/scheduleStore';
import type { ISentinelAuditStore } from '../../db/sentinelAuditStore';
import type { ISentinelSettingsStore } from '../../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import type { ISpaceStore } from '../../db/spaceStore';
import type { ITurnArtifactStore } from '../../db/turnArtifactStore';
import type { IOAuthTokenStore } from '../../mcp/auth/types';

/** The stores one export reads, over whichever database the instance runs on. */
export interface ExportStores<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  modelProviderStore: IModelProviderStore<TTransaction>;
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  auditStore: ISentinelAuditStore;
  close(): Promise<void>;
}

/** Schema errors an older database raises when read by a newer build. */
export function looksLikeOldSchema(message: string): boolean {
  return /no such (table|column)|(relation|column) .* does not exist/i.test(message);
}
