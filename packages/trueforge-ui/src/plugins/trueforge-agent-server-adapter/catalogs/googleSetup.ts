/** Maps the Google connection port onto the generated SDK's `settings.google` routes. */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { GoogleClientDraft, GoogleSetupPort } from '../../../server/googleSetup.js';

/**
 * The test and disconnect calls have no body, so they name JSON as their content type, like the calls that
 * do send a body: a page on another site cannot set that header without a CORS preflight, which is what the
 * server's cross-site check relies on for a call with nothing in it.
 */
const JSON_CONTENT_TYPE = { headers: { 'Content-Type': 'application/json' } };

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
    testGoogleConnection: async () => (await client.settings.google.testConnection(JSON_CONTENT_TYPE)).data,
    disconnectGoogle: async () => (await client.settings.google.disconnect(JSON_CONTENT_TYPE)).data,
  };
}
