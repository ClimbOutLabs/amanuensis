/** Maps the Google connection port onto the generated SDK's `settings.google` routes. */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { GoogleClientDraft, GoogleSetupPort } from '../../../server/googleSetup.js';

function clientBody(client: GoogleClientDraft): TrueForgeApi.GoogleClientCredentials {
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    ...(client.clientType === null ? {} : { clientType: client.clientType }),
  };
}

export function createGoogleSetupApi(client: TrueForge): GoogleSetupPort {
  return {
    getGoogleStatus: async () => (await client.settings.google.getStatus()).data,
    checkGoogleClient: async req =>
      (
        await client.settings.google.checkClient({
          client: clientBody(req.client),
          registeredRedirectUris: req.registeredRedirectUris,
        })
      ).data,
    beginGoogleConsent: async req =>
      (
        await client.settings.google.beginConsent({
          ...(req.client === null ? {} : { client: clientBody(req.client) }),
          features: req.features,
        })
      ).data,
    completeGoogleConsent: async req => (await client.settings.google.completeConsent({ address: req.address })).data,
    testGoogleConnection: async () => (await client.settings.google.testConnection()).data,
    disconnectGoogle: async () => (await client.settings.google.disconnect()).data,
  };
}
