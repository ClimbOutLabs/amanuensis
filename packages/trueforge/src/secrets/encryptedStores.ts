import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { EncryptedGoogleConnectionStore } from './encryptedGoogleConnectionStore';
import { EncryptedMcpServerStore } from './encryptedMcpServerStore';
import { EncryptedModelProviderStore } from './encryptedModelProviderStore';
import { EncryptedOAuthTokenStore } from './encryptedOAuthTokenStore';
import { EncryptedSandboxProviderStore } from './encryptedSandboxProviderStore';
import type { SecretVault } from './secretVault';

export interface SecretBearingStores<TTransaction> {
  modelProviderStore: IModelProviderStore<TTransaction>;
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  googleConnectionStore: IGoogleConnectionStore;
}

/** Wraps the stores that hold saved logins so that only encrypted values reach the database. */
export function encryptSecretStores<TTransaction>({
  stores,
  vault,
}: {
  stores: SecretBearingStores<TTransaction>;
  vault: SecretVault;
}): SecretBearingStores<TTransaction> {
  return {
    modelProviderStore: new EncryptedModelProviderStore({ store: stores.modelProviderStore, vault }),
    sandboxProviderStore: new EncryptedSandboxProviderStore({ store: stores.sandboxProviderStore, vault }),
    mcpServerStore: new EncryptedMcpServerStore({ store: stores.mcpServerStore, vault }),
    tokenStore: new EncryptedOAuthTokenStore({ store: stores.tokenStore, vault }),
    googleConnectionStore: new EncryptedGoogleConnectionStore({ store: stores.googleConnectionStore, vault }),
  };
}
