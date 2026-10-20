/** Wire shapes for the Google connection under `/api/v1/user/settings/google`. Secrets are accepted, never returned. */
import { z } from '@hono/zod-openapi';
import { CLIENT_PROBLEM_CODES, CLIENT_TYPES } from '@truefoundry/trueforge-core/core/google/clientJson';
import { GoogleTestResultSchema } from '@truefoundry/trueforge-core/core/google/GoogleConnectService';
import { GOOGLE_FEATURES } from '@truefoundry/trueforge-core/core/google/scopes';
import { GoogleSetupInfoSchema as CoreGoogleSetupInfoSchema } from '@truefoundry/trueforge-core/core/google/setupMode';

const GoogleClientTypeSchema = z.enum(CLIENT_TYPES).openapi('GoogleClientType');
const GoogleFeatureSchema = z.enum(GOOGLE_FEATURES).openapi('GoogleFeature');

export const GoogleSetupInfoSchema = CoreGoogleSetupInfoSchema.openapi('GoogleSetupInfo');

const GoogleFeatureStatusSchema = z
  .object({
    feature: GoogleFeatureSchema,
    label: z.string().describe('Plain-language name of what the feature allows.'),
    granted: z.boolean().describe('Whether Google granted the scope behind this feature.'),
  })
  .openapi('GoogleFeatureStatus');

const GoogleConnectionStatusSchema = z
  .object({
    state: z
      .enum(['not_connected', 'connected', 'needs_reconnect'])
      .describe('needs_reconnect: Google no longer accepts the stored login; connect again.'),
    account_email: z.string().nullable().describe('The connected Google address; null when not connected or unknown.'),
    features: z.array(GoogleFeatureStatusSchema),
    has_saved_client: z
      .boolean()
      .describe('Whether a Google client is already saved, so adding a feature needs no retyping.'),
    locked: z
      .boolean()
      .describe('True on a demo instance when the connection cannot be changed from Settings right now.'),
    setup: GoogleSetupInfoSchema,
  })
  .openapi('GoogleConnectionStatus');

export const GetGoogleConnectionStatusResponseSchema = z
  .object({ data: GoogleConnectionStatusSchema })
  .openapi('GetGoogleConnectionStatusResponse');

const GoogleClientCredentialsSchema = z
  .object({
    client_id: z.string().min(1).describe("The user's own Google OAuth client id."),
    client_secret: z.string().min(1).describe("The user's own Google OAuth client secret."),
    client_type: GoogleClientTypeSchema.optional(),
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

const GoogleClientProblemSchema = z
  .object({
    code: z.enum(CLIENT_PROBLEM_CODES).describe('Stable problem code.'),
    message: z.string().describe('Plain-language explanation and next step.'),
  })
  .openapi('GoogleClientProblem');

const GoogleClientCheckSchema = z
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
    client: GoogleClientCredentialsSchema.optional(),
    features: z.array(GoogleFeatureSchema).min(1).describe('Features to ask for. Features already granted are kept.'),
  })
  .openapi('BeginGoogleConsentRequest');

const GoogleConsentStartSchema = z
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

const TestGoogleConnectionResultSchema = GoogleTestResultSchema.openapi('TestGoogleConnectionResult');

export const TestGoogleConnectionResponseSchema = z
  .object({ data: TestGoogleConnectionResultSchema })
  .openapi('TestGoogleConnectionResponse');

const DisconnectGoogleResultSchema = z
  .object({
    revocation_confirmed: z
      .boolean()
      .describe('False when Google did not confirm the revocation. The login is removed from Aman either way.'),
  })
  .openapi('DisconnectGoogleResult');

export const DisconnectGoogleResponseSchema = z
  .object({ data: DisconnectGoogleResultSchema })
  .openapi('DisconnectGoogleResponse');
