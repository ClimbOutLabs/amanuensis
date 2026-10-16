import { runSentinelSettingsStoreContractSuite } from '../../db/sentinelSettingsStoreContractSuite';
import { InMemorySentinelSettingsStore } from '../../fixtures/InMemorySentinelSettingsStore';

describe('InMemorySentinelSettingsStore (ISentinelSettingsStore contract)', () => {
  runSentinelSettingsStoreContractSuite(() => new InMemorySentinelSettingsStore());
});
