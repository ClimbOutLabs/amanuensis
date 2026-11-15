import { TrueForgeAuthMode } from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { ILocalUserStore } from '../db/localUserStore';
import type { ITerminalKeyStore } from '../db/terminalKeyStore';
import { TrueFoundryAuthenticator } from '../truefoundry/TrueFoundryAuthenticator';
import type { TrueFoundryServiceFoundryServerClient } from '../truefoundry/TrueFoundryServiceFoundryServerClient';
import type { Authenticator } from './authenticator';
import { LocalAuthenticator } from './localAuthenticator';
import { OidcAuthenticator } from './oidcAuthenticator';
import { StandaloneAuthenticator } from './standaloneAuthenticator';

export type CreateAuthenticatorParams =
  | { mode: TrueForgeAuthMode.Standalone }
  | { mode: TrueForgeAuthMode.Oidc; terminalKeyStore?: ITerminalKeyStore }
  | { mode: TrueForgeAuthMode.TrueFoundry; serviceFoundryClient: TrueFoundryServiceFoundryServerClient }
  | {
      mode: TrueForgeAuthMode.Local;
      localUserStore: ILocalUserStore;
      globalSettingsStore: IGlobalSettingsStore;
      terminalKeyStore?: ITerminalKeyStore;
    };

/** Build the single process authenticator from resolved auth mode. */
export function createAuthenticator(params: CreateAuthenticatorParams): Authenticator {
  switch (params.mode) {
    case TrueForgeAuthMode.TrueFoundry:
      return new TrueFoundryAuthenticator(params.serviceFoundryClient);
    case TrueForgeAuthMode.Oidc:
      return new OidcAuthenticator({
        ...(params.terminalKeyStore === undefined ? {} : { terminalKeyStore: params.terminalKeyStore }),
      });
    case TrueForgeAuthMode.Local:
      return new LocalAuthenticator({
        localUserStore: params.localUserStore,
        globalSettingsStore: params.globalSettingsStore,
        ...(params.terminalKeyStore === undefined ? {} : { terminalKeyStore: params.terminalKeyStore }),
      });
    case TrueForgeAuthMode.Standalone:
      return new StandaloneAuthenticator();
  }
}
