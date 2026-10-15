/**
 * The Google connection port the Harness adds on top of the runtime's connector port, and the response
 * shapes of `/api/v1/user/settings/google`. The server owns the wire; these parsers read it defensively until
 * the generated SDK carries the routes.
 */
import { CLIENT_PROBLEM_CODES, CLIENT_TYPES } from '@truefoundry/trueforge-core/core/google/clientJson';
import { GOOGLE_FEATURES, type GoogleFeature } from '@truefoundry/trueforge-core/core/google/scopes';
import { GOOGLE_SETUP_MODES } from '@truefoundry/trueforge-core/core/google/setupMode';
import { z } from 'zod';

const GoogleSetupInfoSchema = z.object({
  mode: z.enum(GOOGLE_SETUP_MODES),
  client_type: z.enum(CLIENT_TYPES),
  redirect_uri: z.string(),
});

export const GoogleConnectionStatusSchema = z.object({
  state: z.enum(['not_connected', 'connected', 'needs_reconnect']),
  account_email: z.string().nullable(),
  features: z.array(z.object({ feature: z.enum(GOOGLE_FEATURES), label: z.string(), granted: z.boolean() })),
  has_saved_client: z.boolean(),
  setup: GoogleSetupInfoSchema,
});
export type GoogleConnectionStatus = z.infer<typeof GoogleConnectionStatusSchema>;

export const GoogleClientCheckSchema = z.object({
  ok: z.boolean(),
  problems: z.array(z.object({ code: z.enum(CLIENT_PROBLEM_CODES), message: z.string() })),
});
export type GoogleClientCheck = z.infer<typeof GoogleClientCheckSchema>;

export const GoogleConsentStartSchema = z.object({ authorization_url: z.string(), setup: GoogleSetupInfoSchema });
export type GoogleConsentStart = z.infer<typeof GoogleConsentStartSchema>;

export const GoogleTestResultSchema = z.object({
  result: z.enum(['ok', 'not_connected', 'needs_reconnect', 'unreachable']),
  account_email: z.string().nullable(),
});
export type GoogleTestResult = z.infer<typeof GoogleTestResultSchema>;

export const GoogleDisconnectResultSchema = z.object({ disconnected: z.boolean() });
export type GoogleDisconnectResult = z.infer<typeof GoogleDisconnectResultSchema>;

/** The client as the user gave it; the type is known only when it came from a downloaded client file. */
export interface GoogleClientDraft {
  clientId: string;
  clientSecret: string;
  clientType: 'desktop' | 'web' | null;
}

/** Operations behind Settings, Connectors, Google. */
export interface GoogleSetupPort {
  getGoogleStatus(): Promise<GoogleConnectionStatus>;
  /** "Check my client": local checks plus a dry request to Google. Nothing is stored. */
  checkGoogleClient(req: { client: GoogleClientDraft; registeredRedirectUris: string[] }): Promise<GoogleClientCheck>;
  /** A null client reuses the saved one, to add a feature or reconnect. */
  beginGoogleConsent(req: { client: GoogleClientDraft | null; features: GoogleFeature[] }): Promise<GoogleConsentStart>;
  /** Finishes a consent from the whole address the browser was sent to; the server reads the code and state. */
  completeGoogleConsent(req: { address: string }): Promise<GoogleConnectionStatus>;
  testGoogleConnection(): Promise<GoogleTestResult>;
  disconnectGoogle(): Promise<GoogleDisconnectResult>;
}

/** Whether a catalog implements the Google port; another host's catalog may not. */
export function hasGoogleSetup(catalog: object): catalog is GoogleSetupPort {
  return typeof Reflect.get(catalog, 'getGoogleStatus') === 'function';
}
