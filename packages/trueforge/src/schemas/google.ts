/** Wire shapes for the Google connection under `/api/v1/user/settings/google`. Secrets are accepted, never returned. */
import { z } from '@hono/zod-openapi';
import { CLIENT_PROBLEM_CODES, CLIENT_TYPES } from '@truefoundry/trueforge-core/core/google/clientJson';
import { GOOGLE_FEATURES } from '@truefoundry/trueforge-core/core/google/scopes';
import { GOOGLE_SETUP_MODES } from '@truefoundry/trueforge-core/core/google/setupMode';

export const GoogleClientTypeSchema = z.enum(CLIENT_TYPES).openapi('GoogleClientType');
export const GoogleFeatureSchema = z.enum(GOOGLE_FEATURES).openapi('GoogleFeature');

export const GoogleSetupInfoSchema = z
  .object({
    mode: z
      .enum(GOOGLE_SETUP_MODES)
      .describe(
        'web: this install has a public https address and a Web client returns to it. loopback: the browser is on this machine. paste: the user pastes the address Google sends the browser to.',
      ),
    client_type: GoogleClientTypeSchema.describe('The kind of Google client this install needs.'),
    redirect_uri: z
      .string()
      .describe('The exact redirect URI to register (Web client) or that the consent returns to.'),
  })
  .openapi('GoogleSetupInfo');

export const GoogleFeatureStatusSchema = z
  .object({
    feature: GoogleFeatureSchema,
    label: z.string().describe('Plain-language name of what the feature allows.'),
    granted: z.boolean().describe('Whether Google granted the scope behind this feature.'),
  })
  .openapi('GoogleFeatureStatus');

export const GoogleConnectionStatusSchema = z
  .object({
    state: z
      .enum(['not_connected', 'connected', 'needs_reconnect'])
      .describe('needs_reconnect: Google no longer accepts the stored login; connect again.'),
    account_email: z.string().nullable().describe('The connected Google address; null when not connected or unknown.'),
    features: z.array(GoogleFeatureStatusSchema),
    has_saved_client: z
      .boolean()
      .describe('Whether a Google client is already saved, so adding a feature needs no retyping.'),
    setup: GoogleSetupInfoSchema,
  })
  .openapi('GoogleConnectionStatus');

export const GetGoogleConnectionStatusResponseSchema = z
  .object({ data: GoogleConnectionStatusSchema })
  .openapi('GetGoogleConnectionStatusResponse');

export const GoogleClientCredentialsSchema = z
  .object({
    client_id: z.string().min(1).describe("The user's own Google OAuth client id."),
    client_secret: z.string().min(1).describe("The user's own Google OAuth client secret."),
    client_type: GoogleClientTypeSchema.nullable().describe(
      'The type read from the downloaded client file, or null when the id and secret were typed in.',
    ),
  })
  .openapi('GoogleClientCredentials');

export const CheckGoogleClientRequestSchema = z
  .object({
    client: GoogleClientCredentialsSchema,
    registered_redirect_uris: z
      .array(z.string())
      .describe('Authorized redirect URIs listed in a Web client file; empty when unknown.'),
  })
  .openapi('CheckGoogleClientRequest');

export const GoogleClientProblemSchema = z
  .object({
    code: z.enum(CLIENT_PROBLEM_CODES).describe('Stable problem code.'),
    message: z.string().describe('Plain-language explanation and next step.'),
  })
  .openapi('GoogleClientProblem');

export const GoogleClientCheckSchema = z
  .object({
    ok: z.boolean().describe('True when no problem was found.'),
    problems: z.array(GoogleClientProblemSchema),
  })
  .openapi('GoogleClientCheck');

export const CheckGoogleClientResponseSchema = z
  .object({ data: GoogleClientCheckSchema })
  .openapi('CheckGoogleClientResponse');

export const BeginGoogleConsentRequestSchema = z
  .object({
    client: GoogleClientCredentialsSchema.optional().describe(
      'The user’s client. Omit it to reuse the saved client, to add a feature or reconnect.',
    ),
    features: z.array(GoogleFeatureSchema).min(1).describe('Features to ask for. Features already granted are kept.'),
  })
  .openapi('BeginGoogleConsentRequest');

export const GoogleConsentStartSchema = z
  .object({
    authorization_url: z.string().describe('The Google consent address to open in the browser.'),
    setup: GoogleSetupInfoSchema,
  })
  .openapi('GoogleConsentStart');

export const BeginGoogleConsentResponseSchema = z
  .object({ data: GoogleConsentStartSchema })
  .openapi('BeginGoogleConsentResponse');

export const GoogleConsentCallbackQuerySchema = z
  .object({
    code: z.string().optional().describe('Authorization code from Google.'),
    state: z.string().optional().describe('State echoed back by Google.'),
    error: z.string().optional().describe('Set by Google when the user declined.'),
  })
  .openapi('GoogleConsentCallbackQuery');

export const CompleteGoogleConsentRequestSchema = z
  .object({
    address: z
      .string()
      .min(1)
      .describe('The whole address copied from the browser bar after consent; its code and state are read here.'),
  })
  .openapi('CompleteGoogleConsentRequest');

export const TestGoogleConnectionResultSchema = z
  .object({
    result: z.enum(['ok', 'not_connected', 'needs_reconnect', 'unreachable']),
    account_email: z.string().nullable().describe('The connected address when the test passed.'),
  })
  .openapi('TestGoogleConnectionResult');

export const TestGoogleConnectionResponseSchema = z
  .object({ data: TestGoogleConnectionResultSchema })
  .openapi('TestGoogleConnectionResponse');

export const DisconnectGoogleResultSchema = z
  .object({
    disconnected: z
      .boolean()
      .describe(
        'False when Google could not confirm the revocation; nothing was deleted and Disconnect can be retried.',
      ),
  })
  .openapi('DisconnectGoogleResult');

export const DisconnectGoogleResponseSchema = z
  .object({ data: DisconnectGoogleResultSchema })
  .openapi('DisconnectGoogleResponse');
